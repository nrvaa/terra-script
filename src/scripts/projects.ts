/**
 * Project storage in IndexedDB (in this browser, on this computer).
 * `projects` holds light metadata for the project list, `scripts` the full
 * documents, `snapshots` the version history and `images` the storyboard
 * drawings (kept out of the document so undo and snapshots stay light).
 */
import { normalizeTitlePage, parseFountain } from './fountain';
import { layoutScript } from './pdf';
import {
  BOARD_ASPECTS,
  CAMERA_MOVES,
  CARD_COLORS,
  ELEMENTS,
  REV_COLORS,
  SHOT_ANGLES,
  SHOT_SIZES,
  TAG_CATS,
  TAKE_STATUSES,
  characterName,
  type BoardAspect,
  type CameraMove,
  type ElementStyle,
  type Panel,
  type ShotAngle,
  type ShotSize,
  type RevColor,
  type Revision,
  type Run,
  type TagCat,
  type Take,
  type TakeStatus,
  type Block,
  type CardColor,
  type ElType,
  type ScriptDoc,
  type ScriptLayout,
  type TitlePage,
} from './types';

export interface ProjectMeta {
  id: string;
  title: string;
  author: string;
  createdAt: number;
  updatedAt: number;
  pages: number;
  scenes: number;
  words: number;
  characters: number;
  /** Last time a .terra copy was downloaded (or the project came from one). */
  backedUpAt?: number;
  /** false = the user turned backup reminders off for this project. */
  remindBackup?: boolean;
}

const DB_NAME = 'tewrite';
const DB_VERSION = 4; // 2: snapshots store, 3: storyboard images, 4: repair a v3 without the images store
const LEGACY_KEY = 'tewrite:doc';
const UNSAVED_PREFIX = 'tewrite:unsaved:';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    let blockedTimer = 0;
    const open = (version?: number) => {
      const req = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('scripts')) db.createObjectStore('scripts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('snapshots')) {
          db.createObjectStore('snapshots', { keyPath: 'id' }).createIndex('project', 'projectId');
        }
        if (!db.objectStoreNames.contains('images')) {
          db.createObjectStore('images', { keyPath: 'key' }).createIndex('project', 'projectId');
        }
      };
      req.onsuccess = () => {
        window.clearTimeout(blockedTimer);
        // Let a newer version of the app (in another tab) upgrade the database.
        req.result.onversionchange = () => {
          req.result.close();
          dbPromise = null;
        };
        resolve(req.result);
      };
      req.onerror = () => {
        window.clearTimeout(blockedTimer);
        // A newer version of the app already upgraded the database (e.g. an older
        // desktop install opened after a newer one): open it as it is. Newer
        // versions only ever add stores, so everything here keeps working.
        if (version && req.error?.name === 'VersionError') return open();
        reject(req.error);
      };
      // Another tab still holds the old version open. The upgrade continues as
      // soon as it lets go; only give up if that takes too long.
      req.onblocked = () => {
        blockedTimer = window.setTimeout(() => reject(new Error('IndexedDB blocked')), 8000);
      };
    };
    open(DB_VERSION);
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('aborted'));
  });

const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export function newId(): string {
  const rnd = crypto.getRandomValues(new Uint8Array(6));
  return Date.now().toString(36) + Array.from(rnd, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 8);
}

/* ------------------------------------------------------------------ */
/* Stats                                                               */
/* ------------------------------------------------------------------ */

const countWords = (s: string) => s.trim().match(/\S+/g)?.length ?? 0;

function paperSetting(): 'letter' | 'a4' {
  try {
    return JSON.parse(localStorage.getItem('tewrite:settings') || '{}').paper === 'a4' ? 'a4' : 'letter';
  } catch {
    return 'letter';
  }
}

export function computeStats(blocks: Block[]) {
  const names = new Set<string>();
  let scenes = 0;
  let words = 0;
  for (const b of blocks) {
    if (b.type === 'scene') scenes++;
    if (b.type === 'character' && characterName(b.text)) names.add(characterName(b.text));
    if (b.type !== 'note') words += countWords(b.text);
  }
  let pages = 1;
  try {
    pages = Math.max(1, layoutScript(blocks, { paper: paperSetting(), sceneNumbers: false }).length);
  } catch {
    /* keep 1 */
  }
  return { pages, scenes, words, characters: names.size };
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

export async function listProjects(): Promise<ProjectMeta[]> {
  const db = await openDb();
  const tx = db.transaction('projects', 'readonly');
  const all = await request(tx.objectStore('projects').getAll() as IDBRequest<ProjectMeta[]>);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadProject(id: string): Promise<{ meta: ProjectMeta; doc: ScriptDoc } | null> {
  const db = await openDb();
  const tx = db.transaction(['projects', 'scripts'], 'readonly');
  const [meta, row] = await Promise.all([
    request(tx.objectStore('projects').get(id) as IDBRequest<ProjectMeta | undefined>),
    request(tx.objectStore('scripts').get(id) as IDBRequest<{ id: string; doc: ScriptDoc } | undefined>),
  ]);
  if (!meta || !row) return null;
  return { meta, doc: row.doc };
}

/** Save a document (creating the project if needed). */
export async function saveProject(id: string, doc: ScriptDoc, opts: { touch?: boolean } = {}): Promise<ProjectMeta> {
  // Drawings that came inside a .terra file go to the image store.
  doc = await storeInlineImages(id, doc);
  const db = await openDb();
  const tx = db.transaction(['projects', 'scripts'], 'readwrite');
  const projects = tx.objectStore('projects');
  const existing = await request(projects.get(id) as IDBRequest<ProjectMeta | undefined>);
  const now = Date.now();
  const meta: ProjectMeta = {
    id,
    title: doc.titlePage.title.trim(),
    author: doc.titlePage.author.trim(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: opts.touch === false && existing ? existing.updatedAt : now,
    ...computeStats(doc.blocks),
    // Backup bookkeeping survives normal saves.
    ...(existing?.backedUpAt ? { backedUpAt: existing.backedUpAt } : {}),
    ...(existing?.remindBackup === false ? { remindBackup: false } : {}),
  };
  projects.put(meta);
  tx.objectStore('scripts').put({ id, doc });
  await done(tx);
  return meta;
}

export async function createProject(doc: ScriptDoc): Promise<string> {
  const id = newId();
  await saveProject(id, doc);
  return id;
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['projects', 'scripts', 'snapshots', 'images'], 'readwrite');
  tx.objectStore('projects').delete(id);
  tx.objectStore('scripts').delete(id);
  for (const name of ['snapshots', 'images']) {
    const store = tx.objectStore(name);
    const keys = await request(store.index('project').getAllKeys(id));
    for (const k of keys) store.delete(k);
  }
  await done(tx);
  try {
    localStorage.removeItem(UNSAVED_PREFIX + id);
  } catch {
    /* ignore */
  }
}

export async function renameProject(id: string, title: string): Promise<void> {
  const p = await loadProject(id);
  if (!p) return;
  p.doc.titlePage.title = title;
  await saveProject(id, p.doc);
}

export async function duplicateProject(id: string, makeTitle: (t: string) => string): Promise<string | null> {
  const p = await loadProject(id);
  if (!p) return null;
  const doc: ScriptDoc = structuredClone(p.doc);
  doc.titlePage.title = makeTitle(doc.titlePage.title);
  const copy = await createProject(doc);
  // The copy gets its own storyboard drawings.
  const db = await openDb();
  const read = db.transaction('images', 'readonly');
  const rows = await request(read.objectStore('images').index('project').getAll(id) as IDBRequest<ImageRow[]>);
  if (rows.length) {
    const tx = db.transaction('images', 'readwrite');
    for (const r of rows) tx.objectStore('images').put({ ...r, key: imageKey(copy, r.id), projectId: copy });
    await done(tx);
  }
  return copy;
}

/* ------------------------------------------------------------------ */
/* Storyboard images                                                   */
/* ------------------------------------------------------------------ */

/* A drawing never changes once stored: editing a panel saves a new image with
   a new id. Undo, snapshots and other projects can therefore point at old ids
   safely; images nobody refers to any more are removed by gcImages().
   The bytes are stored as a plain ArrayBuffer, not a Blob: Safari (every
   browser on iPhone and iPad) can fail to store or read back Blobs in
   IndexedDB, while ArrayBuffers work everywhere. */

interface ImageRow {
  key: string;
  projectId: string;
  id: string;
  data: ArrayBuffer;
  type: string;
  at: number;
  /** Rows written by the first storyboard version. */
  blob?: Blob;
}

const imageKey = (projectId: string, id: string) => `${projectId}/${id}`;
const IMAGE_ID = /^[a-z0-9]{1,40}$/i;
const IMAGE_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
/** Keep unreferenced images this long, in case another tab is still using them. */
const IMAGE_GRACE = 60 * 60 * 1000;

export async function putImage(projectId: string, id: string, blob: Blob): Promise<void> {
  // Read the bytes before opening the transaction (it would close while we wait).
  const data = await blob.arrayBuffer();
  const db = await openDb();
  const tx = db.transaction('images', 'readwrite');
  const row: ImageRow = { key: imageKey(projectId, id), projectId, id, data, type: blob.type || 'image/png', at: Date.now() };
  tx.objectStore('images').put(row);
  await done(tx);
}

export async function getImage(projectId: string, id: string): Promise<Blob | undefined> {
  const db = await openDb();
  const tx = db.transaction('images', 'readonly');
  const row = await request(tx.objectStore('images').get(imageKey(projectId, id)) as IDBRequest<ImageRow | undefined>);
  if (!row) return undefined;
  return row.data ? new Blob([row.data], { type: row.type }) : row.blob;
}

/** Ids of every drawing the blocks use, omitted scenes included. */
export function imageIds(blocks: Block[], into = new Set<string>()): Set<string> {
  for (const b of blocks) {
    for (const p of b.board ?? []) if (p.img) into.add(p.img);
    if (b.omit) imageIds(b.omit, into);
  }
  return into;
}

function dataUrlBytes(url: string): { data: ArrayBuffer; type: string } {
  const comma = url.indexOf(',');
  const type = url.slice(5, url.indexOf(';'));
  const bin = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { data: bytes.buffer, type };
}

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

async function storeInlineImages(projectId: string, doc: ScriptDoc): Promise<ScriptDoc> {
  if (!doc.images) return doc;
  const { images, ...rest } = doc;
  const entries = Object.entries(images).filter(([id, url]) => IMAGE_ID.test(id) && IMAGE_URL.test(url));
  if (entries.length) {
    const db = await openDb();
    const tx = db.transaction('images', 'readwrite');
    const now = Date.now();
    for (const [id, url] of entries) {
      const row: ImageRow = { key: imageKey(projectId, id), projectId, id, ...dataUrlBytes(url), at: now };
      tx.objectStore('images').put(row);
    }
    await done(tx);
  }
  return rest;
}

/** Remove drawings that neither the project, its snapshots nor an unsaved copy use. */
export async function gcImages(projectId: string): Promise<void> {
  const db = await openDb();
  const read = db.transaction(['scripts', 'snapshots'], 'readonly');
  const [row, snaps] = await Promise.all([
    request(read.objectStore('scripts').get(projectId) as IDBRequest<{ id: string; doc: ScriptDoc } | undefined>),
    request(read.objectStore('snapshots').index('project').getAll(projectId) as IDBRequest<Snapshot[]>),
  ]);
  if (!row) return;
  const keep = imageIds(row.doc.blocks);
  for (const s of snaps) imageIds(s.doc.blocks, keep);
  try {
    const raw = localStorage.getItem(UNSAVED_PREFIX + projectId);
    if (raw) imageIds((JSON.parse(raw) as { doc?: ScriptDoc }).doc?.blocks ?? [], keep);
  } catch {
    /* ignore */
  }
  const tx = db.transaction('images', 'readwrite');
  const store = tx.objectStore('images');
  const keys = await request(store.index('project').getAllKeys(projectId));
  const old = Date.now() - IMAGE_GRACE;
  for (const key of keys) {
    const id = String(key).slice(projectId.length + 1);
    if (keep.has(id)) continue;
    const r = await request(store.get(key) as IDBRequest<ImageRow | undefined>);
    if (r && r.at < old) store.delete(key);
  }
  await done(tx);
}

/** The project as a .terra file, with its storyboard drawings inside. */
export async function serializeProject(projectId: string | null, doc: ScriptDoc): Promise<string> {
  const ids = imageIds(doc.blocks);
  if (!projectId || !ids.size) return serializeTerra(doc);
  const images: Record<string, string> = {};
  for (const id of ids) {
    const blob = await getImage(projectId, id);
    if (blob) images[id] = await blobToDataUrl(blob);
  }
  return serializeTerra({ ...doc, images });
}

/* ------------------------------------------------------------------ */
/* Snapshots (document history)                                        */
/* ------------------------------------------------------------------ */

export interface Snapshot {
  id: string;
  projectId: string;
  at: number;
  /** User label; empty for automatic snapshots. */
  label: string;
  auto: boolean;
  writer: string;
  words: number;
  pages: number;
  doc: ScriptDoc;
}

const MAX_AUTO_SNAPSHOTS = 40;

export async function listSnapshots(projectId: string): Promise<Snapshot[]> {
  const db = await openDb();
  const tx = db.transaction('snapshots', 'readonly');
  const all = await request(tx.objectStore('snapshots').index('project').getAll(projectId) as IDBRequest<Snapshot[]>);
  return all.sort((a, b) => b.at - a.at);
}

export async function saveSnapshot(projectId: string, doc: ScriptDoc, opts: { label?: string; auto?: boolean; writer?: string } = {}): Promise<Snapshot> {
  const stats = computeStats(doc.blocks);
  const snap: Snapshot = {
    id: newId(),
    projectId,
    at: Date.now(),
    label: (opts.label ?? '').trim().slice(0, 120),
    auto: Boolean(opts.auto),
    writer: (opts.writer ?? '').trim().slice(0, 80),
    words: stats.words,
    pages: stats.pages,
    doc: structuredClone(doc),
  };
  const db = await openDb();
  const tx = db.transaction('snapshots', 'readwrite');
  const store = tx.objectStore('snapshots');
  store.put(snap);
  // Keep the newest automatic snapshots only; named ones stay until deleted.
  const all = await request(store.index('project').getAll(projectId) as IDBRequest<Snapshot[]>);
  const autos = all.filter((s) => s.auto && s.id !== snap.id).sort((a, b) => b.at - a.at);
  for (const old of autos.slice(MAX_AUTO_SNAPSHOTS - 1)) store.delete(old.id);
  await done(tx);
  return snap;
}

export async function deleteSnapshot(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('snapshots', 'readwrite');
  tx.objectStore('snapshots').delete(id);
  await done(tx);
}

export async function renameSnapshot(id: string, label: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('snapshots', 'readwrite');
  const store = tx.objectStore('snapshots');
  const s = await request(store.get(id) as IDBRequest<Snapshot | undefined>);
  if (s) store.put({ ...s, label: label.trim().slice(0, 120), auto: false });
  await done(tx);
}

/* ------------------------------------------------------------------ */
/* Import / legacy                                                     */
/* ------------------------------------------------------------------ */

/* .terra: the complete project in one JSON file — script, title page, index
   cards (synopsis + colour) and page layout — so it opens exactly the same on
   any device. Older .tewrite files are the same shape without the header. */

export const TERRA_FORMAT = 'terra-script';
export const TERRA_VERSION = 2;

export function serializeTerra(doc: ScriptDoc): string {
  return JSON.stringify(
    {
      format: TERRA_FORMAT,
      version: TERRA_VERSION,
      app: 'Terra Script',
      exportedAt: new Date().toISOString(),
      titlePage: doc.titlePage,
      layout: doc.layout,
      ...(doc.revision ? { revision: doc.revision } : {}),
      ...(doc.tags?.length ? { tags: doc.tags } : {}),
      blocks: doc.blocks,
      // Storyboard drawings last, so the script stays readable at the top of the file.
      ...(doc.images && Object.keys(doc.images).length ? { images: doc.images } : {}),
    },
    null,
    2,
  );
}

const VALID_TYPES = new Set<string>(ELEMENTS.map((e) => e.type));

/** Validate untrusted JSON into a clean ScriptDoc (unknown fields are dropped). */
export function parseTerra(text: string): ScriptDoc {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.blocks)) throw new Error('format');
  if (raw.format !== undefined && raw.format !== TERRA_FORMAT) throw new Error('format');
  const blocks = parseBlocks(raw.blocks as unknown[], 0);
  const l = raw.layout as Record<string, unknown> | undefined;
  const layout: ScriptLayout | undefined = l && typeof l === 'object' ? parseLayout(l) : undefined;
  const tp = (raw.titlePage && typeof raw.titlePage === 'object' ? raw.titlePage : {}) as Record<string, unknown>;
  const titlePage = normalizeTitlePage(
    Object.fromEntries(Object.entries(tp).filter(([, v]) => typeof v === 'string')) as Partial<TitlePage>,
  );
  const doc: ScriptDoc = { version: TERRA_VERSION, titlePage, blocks, ...(layout ? { layout } : {}) };
  const rv = raw.revision as Record<string, unknown> | undefined;
  if (rv && typeof rv === 'object') {
    const revision: Revision = {
      color: REV_COLORS.includes(rv.color as RevColor) ? (rv.color as RevColor) : 'blue',
      date: typeof rv.date === 'string' ? rv.date.slice(0, 40) : '',
    };
    if (Array.isArray(rv.baseline)) {
      revision.baseline = (rv.baseline as Record<string, unknown>[])
        .filter((x) => x && typeof x === 'object' && typeof x.text === 'string')
        .map((x) => ({ type: (VALID_TYPES.has(x.type as string) ? x.type : 'action') as ElType, text: (x.text as string).replace(/\r?\n/g, ' ') }));
    }
    doc.revision = revision;
  }
  if (Array.isArray(raw.tags)) {
    const tags = (raw.tags as Record<string, unknown>[])
      .filter((x) => x && typeof x === 'object' && typeof x.text === 'string' && TAG_CATS.includes(x.cat as TagCat))
      .map((x) => ({ text: (x.text as string).replace(/\s+/g, ' ').trim().slice(0, 120), cat: x.cat as TagCat }))
      .filter((x) => x.text);
    if (tags.length) doc.tags = tags;
  }
  if (raw.images && typeof raw.images === 'object') {
    const images: Record<string, string> = {};
    for (const [id, url] of Object.entries(raw.images as Record<string, unknown>)) {
      if (IMAGE_ID.test(id) && typeof url === 'string' && url.length < 16_000_000 && IMAGE_URL.test(url)) images[id] = url;
    }
    if (Object.keys(images).length) doc.images = images;
  }
  return doc;
}

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v) : '');

function parseLayout(l: Record<string, unknown>): ScriptLayout {
  const slots = (v: unknown): [string, string, string] | undefined =>
    Array.isArray(v) && v.length === 3 ? (v.map((s) => str(s, 120)) as [string, string, string]) : undefined;
  const layout: ScriptLayout = { paper: l.paper === 'a4' ? 'a4' : 'letter', sceneNumbers: l.sceneNumbers !== false };
  if (['left', 'right', 'both'].includes(l.sceneNumberSide as string)) layout.sceneNumberSide = l.sceneNumberSide as ScriptLayout['sceneNumberSide'];
  if (l.sceneLetterStyle === 'prefix') layout.sceneLetterStyle = 'prefix';
  for (const k of ['sceneNumbersLocked', 'pagesLocked', 'firstPageHeader', 'more', 'autoContd', 'sceneContinueds', 'revMarks'] as const) {
    if (typeof l[k] === 'boolean') layout[k] = l[k] as boolean;
  }
  const header = slots(l.header);
  const footer = slots(l.footer);
  if (header) layout.header = header;
  if (footer) layout.footer = footer;
  for (const k of ['moreText', 'contdText', 'watermark'] as const) if (typeof l[k] === 'string') layout[k] = str(l[k], 60);
  if (BOARD_ASPECTS.includes(l.boardAspect as BoardAspect)) layout.boardAspect = l.boardAspect as BoardAspect;
  if (l.styles && typeof l.styles === 'object') {
    const styles: ScriptLayout['styles'] = {};
    for (const [type, v] of Object.entries(l.styles as Record<string, Record<string, unknown>>)) {
      if (!VALID_TYPES.has(type) || !v || typeof v !== 'object') continue;
      const s: Partial<ElementStyle> = {};
      for (const f of ['caps', 'bold', 'italic', 'underline'] as const) if (typeof v[f] === 'boolean') s[f] = v[f] as boolean;
      if (typeof v.before === 'number' && v.before >= 0 && v.before <= 4) s.before = Math.round(v.before);
      styles[type as ElType] = s;
    }
    layout.styles = styles;
  }
  return layout;
}

function parseRuns(v: unknown, len: number): Run[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const runs = v
    .filter((r): r is [number, number, string] => Array.isArray(r) && r.length === 3 && Number.isInteger(r[0]) && Number.isInteger(r[1]) && typeof r[2] === 'string')
    .map(([s, e, f]) => [Math.max(0, s), Math.min(len, e), f.replace(/[^bius]/g, '').slice(0, 4)] as Run)
    .filter(([s, e, f]) => e > s && f);
  return runs.length ? runs : undefined;
}

function parseBlocks(items: unknown[], depth: number): Block[] {
  const blocks: Block[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const b = item as Record<string, unknown>;
    if (typeof b.text !== 'string') continue;
    const type = (VALID_TYPES.has(b.type as string) ? b.type : 'action') as ElType;
    const block: Block = { type, text: b.text.replace(/\r?\n/g, ' ') };
    const fmt = parseRuns(b.fmt, block.text.length);
    if (fmt) block.fmt = fmt;
    if (b.mark === true) block.mark = true;
    if (typeof b.pg === 'string' && b.pg.trim()) {
      block.pg = b.pg.slice(0, 12);
      if (Number.isInteger(b.pgLine) && (b.pgLine as number) > 0) block.pgLine = b.pgLine as number;
    }
    if (type === 'character' && b.dual === true) block.dual = true;
    if (type === 'scene') {
      if (typeof b.num === 'string' && b.num.trim()) block.num = b.num.slice(0, 12);
      if (b.newPage === true) block.newPage = true;
      if (depth === 0 && Array.isArray(b.omit)) {
        const omit = parseBlocks(b.omit as unknown[], 1);
        if (omit.length) block.omit = omit;
      }
      if (typeof b.synopsis === 'string' && b.synopsis.trim()) block.synopsis = b.synopsis;
      if (CARD_COLORS.includes(b.color as CardColor)) block.color = b.color as CardColor;
      if (Array.isArray(b.takes)) {
        const takes: Take[] = (b.takes as Record<string, unknown>[])
          .filter((x) => x && typeof x === 'object')
          .map((x) => ({
            id: str(x.id) || newId(),
            slate: str(x.slate),
            take: str(x.take),
            camera: str(x.camera),
            roll: str(x.roll),
            status: TAKE_STATUSES.includes(x.status as TakeStatus) ? (x.status as TakeStatus) : '',
            note: str(x.note),
            at: typeof x.at === 'number' && Number.isFinite(x.at) ? x.at : 0,
          }));
        if (takes.length) block.takes = takes;
      }
      if (Array.isArray(b.board)) {
        const board: Panel[] = (b.board as Record<string, unknown>[])
          .filter((x) => x && typeof x === 'object')
          .slice(0, 500)
          .map((x) => {
            const p: Panel = { id: (IMAGE_ID.test(str(x.id)) && str(x.id)) || newId() };
            if (typeof x.img === 'string' && IMAGE_ID.test(x.img)) p.img = x.img;
            if (SHOT_SIZES.includes(x.shot as ShotSize)) p.shot = x.shot as ShotSize;
            if (SHOT_ANGLES.includes(x.angle as ShotAngle)) p.angle = x.angle as ShotAngle;
            if (CAMERA_MOVES.includes(x.move as CameraMove)) p.move = x.move as CameraMove;
            const dur = str(x.dur, 20).trim();
            if (dur) p.dur = dur;
            const note = str(x.note, 2000);
            if (note.trim()) p.note = note;
            return p;
          });
        if (board.length) block.board = board;
      }
    }
    blocks.push(block);
  }
  return blocks;
}

export async function parseScriptFile(file: File): Promise<ScriptDoc> {
  // Converters are loaded only when needed (PDF.js is large).
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    const { pdfToDoc } = await import('./convert-pdf');
    return pdfToDoc(file);
  }
  const text = await file.text();
  if (/\.(terra|tewrite)$/i.test(file.name)) return parseTerra(text);
  if (/\.json$/i.test(file.name)) {
    // A .terra file saved as .json opens as one; any other screenplay JSON is converted.
    const raw = JSON.parse(text) as Record<string, unknown>;
    const terraShaped =
      raw?.format === TERRA_FORMAT ||
      (Array.isArray(raw?.blocks) && (raw.blocks as Record<string, unknown>[]).every((b) => b && VALID_TYPES.has(b.type as string) && typeof b.text === 'string'));
    if (terraShaped) return parseTerra(text);
    const { jsonToDoc } = await import('./convert-json');
    return jsonToDoc(text, file.name);
  }
  const parsed = parseFountain(text);
  if (!parsed.titlePage.title) parsed.titlePage.title = file.name.replace(/\.[^.]+$/, '');
  return { version: 1, titlePage: normalizeTitlePage(parsed.titlePage), blocks: parsed.blocks };
}

export async function importFile(file: File): Promise<string> {
  const id = await createProject(await parseScriptFile(file));
  // Opening a .terra file means a backup already exists on disk.
  if (/\.(terra|tewrite)$/i.test(file.name)) await markBackedUp(id);
  return id;
}

/* ------------------------------------------------------------------ */
/* Backups                                                             */
/* ------------------------------------------------------------------ */

const BACKUP_REMIND_AFTER = 3 * 24 * 60 * 60 * 1000; // 3 days

async function updateMeta(id: string, patch: Partial<ProjectMeta>): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('projects', 'readwrite');
  const store = tx.objectStore('projects');
  const meta = await request(store.get(id) as IDBRequest<ProjectMeta | undefined>);
  if (!meta) return;
  store.put({ ...meta, ...patch });
  await done(tx);
}

/** Record that the user now has an up-to-date .terra copy of this project. */
export const markBackedUp = (id: string) => updateMeta(id, { backedUpAt: Date.now() });

export const setBackupReminder = (id: string, on: boolean) => updateMeta(id, { remindBackup: on });

/** Has the project changed since its last backup (or never been backed up)? */
export function needsBackup(meta: ProjectMeta): boolean {
  return meta.words > 0 && meta.updatedAt > (meta.backedUpAt ?? 0);
}

/** Should we nag about a backup when this project is opened? */
export function shouldRemindBackup(meta: ProjectMeta, now = Date.now()): boolean {
  if (meta.remindBackup === false || !needsBackup(meta)) return false;
  return now - (meta.backedUpAt ?? meta.createdAt) > BACKUP_REMIND_AFTER;
}

/**
 * Ask the browser not to evict our data when it runs low on space
 * (Safari otherwise may clear site data after ~7 days without a visit).
 * It can't stop a user from clearing browsing data themselves.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/** Turn the single script saved by older versions into the first project. */
export async function migrateLegacy(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const doc = JSON.parse(raw) as ScriptDoc;
    if (Array.isArray(doc.blocks) && doc.blocks.length) {
      await createProject({ version: 1, titlePage: normalizeTitlePage(doc.titlePage), blocks: doc.blocks });
    }
    // Keep a copy rather than deleting outright, just in case.
    localStorage.setItem(`${LEGACY_KEY}:migrated`, raw);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* leave it for the next attempt */
  }
}

/* ------------------------------------------------------------------ */
/* Last-moment snapshot (page closing before IndexedDB finished)       */
/* ------------------------------------------------------------------ */

export function writeUnsaved(id: string, doc: ScriptDoc) {
  try {
    localStorage.setItem(UNSAVED_PREFIX + id, JSON.stringify({ at: Date.now(), doc }));
  } catch {
    /* ignore */
  }
}

export function takeUnsaved(id: string, newerThan: number): ScriptDoc | null {
  try {
    const raw = localStorage.getItem(UNSAVED_PREFIX + id);
    if (!raw) return null;
    localStorage.removeItem(UNSAVED_PREFIX + id);
    const { at, doc } = JSON.parse(raw) as { at: number; doc: ScriptDoc };
    return at > newerThan && Array.isArray(doc?.blocks) ? doc : null;
  } catch {
    return null;
  }
}

export function clearUnsaved(id: string) {
  try {
    localStorage.removeItem(UNSAVED_PREFIX + id);
  } catch {
    /* ignore */
  }
}

export const editorUrl = (id: string) => `/write/?p=${encodeURIComponent(id)}`;
