/**
 * Project storage in IndexedDB (in this browser, on this computer).
 * Two stores: `projects` holds light metadata for the project list,
 * `scripts` holds the full documents.
 */
import { normalizeTitlePage, parseFountain } from './fountain';
import { layoutScript } from './pdf';
import {
  CARD_COLORS,
  ELEMENTS,
  REV_COLORS,
  TAG_CATS,
  TAKE_STATUSES,
  characterName,
  type ElementStyle,
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
const DB_VERSION = 2; // 2: snapshots store
const LEGACY_KEY = 'tewrite:doc';
const UNSAVED_PREFIX = 'tewrite:unsaved:';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('scripts')) db.createObjectStore('scripts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('snapshots')) {
        db.createObjectStore('snapshots', { keyPath: 'id' }).createIndex('project', 'projectId');
      }
    };
    req.onsuccess = () => {
      // Let a newer version of the app (in another tab) upgrade the database.
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
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
  const tx = db.transaction(['projects', 'scripts', 'snapshots'], 'readwrite');
  tx.objectStore('projects').delete(id);
  tx.objectStore('scripts').delete(id);
  const snaps = tx.objectStore('snapshots');
  const keys = await request(snaps.index('project').getAllKeys(id));
  for (const k of keys) snaps.delete(k);
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
  return createProject(doc);
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
    }
    blocks.push(block);
  }
  return blocks;
}

export async function parseScriptFile(file: File): Promise<ScriptDoc> {
  const text = await file.text();
  if (/\.(terra|tewrite|json)$/i.test(file.name)) return parseTerra(text);
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
