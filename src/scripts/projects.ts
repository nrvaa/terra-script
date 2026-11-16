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
  TAKE_STATUSES,
  characterName,
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
}

const DB_NAME = 'tewrite';
const DB_VERSION = 1;
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
    };
    req.onsuccess = () => resolve(req.result);
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
  const tx = db.transaction(['projects', 'scripts'], 'readwrite');
  tx.objectStore('projects').delete(id);
  tx.objectStore('scripts').delete(id);
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
  const blocks: Block[] = [];
  for (const item of raw.blocks as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const b = item as Record<string, unknown>;
    if (typeof b.text !== 'string') continue;
    const type = (VALID_TYPES.has(b.type as string) ? b.type : 'action') as ElType;
    const block: Block = { type, text: b.text.replace(/\r?\n/g, ' ') };
    if (type === 'character' && b.dual === true) block.dual = true;
    if (type === 'scene') {
      if (typeof b.synopsis === 'string' && b.synopsis.trim()) block.synopsis = b.synopsis;
      if (CARD_COLORS.includes(b.color as CardColor)) block.color = b.color as CardColor;
      if (Array.isArray(b.takes)) {
        const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 500) : typeof v === 'number' ? String(v) : '');
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
  const l = raw.layout as Partial<ScriptLayout> | undefined;
  const layout: ScriptLayout | undefined =
    l && typeof l === 'object'
      ? { paper: l.paper === 'a4' ? 'a4' : 'letter', sceneNumbers: l.sceneNumbers !== false }
      : undefined;
  const tp = (raw.titlePage && typeof raw.titlePage === 'object' ? raw.titlePage : {}) as Record<string, unknown>;
  const titlePage = normalizeTitlePage(
    Object.fromEntries(Object.entries(tp).filter(([, v]) => typeof v === 'string')) as Partial<TitlePage>,
  );
  return { version: TERRA_VERSION, titlePage, blocks, ...(layout ? { layout } : {}) };
}

export async function parseScriptFile(file: File): Promise<ScriptDoc> {
  const text = await file.text();
  if (/\.(terra|tewrite|json)$/i.test(file.name)) return parseTerra(text);
  const parsed = parseFountain(text);
  if (!parsed.titlePage.title) parsed.titlePage.title = file.name.replace(/\.[^.]+$/, '');
  return { version: 1, titlePage: normalizeTitlePage(parsed.titlePage), blocks: parsed.blocks };
}

export async function importFile(file: File): Promise<string> {
  return createProject(await parseScriptFile(file));
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
