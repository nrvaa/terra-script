/**
 * Production tab: pre-production tools built on the script.
 *   Database (locations, cast, crew) · Schedule (stripboard, day out of days)
 *   · Call sheet · Wardrobe · Budget · Moodboard
 * Everything is stored in the document (`production`), so it is saved with
 * the project, kept in snapshots and carried in .terra files.
 *
 * Sections render HTML strings. Form fields bind themselves: an element with
 * data-f="field" inside a [data-coll][data-id] container edits that record.
 * Records the script implies (a character, a location) have ids like
 * "cast:MAYA" and become real records on their first edit.
 */
import type { ScreenplayEditor } from './editor';
import { getLang, t, type Key } from './i18n';
import { getImage, newId, putImage } from './projects';
import { isDerived, mergedCast, mergedLocations, type SceneInfo } from './production-data';
import { createDatabase } from './prod-db';
import { createSchedule } from './prod-schedule';
import { createCallSheet } from './prod-callsheet';
import { createWardrobe } from './prod-wardrobe';
import { createBudget } from './prod-budget';
import { createMoodboard } from './prod-mood';
import { emptyProduction, type CastRec, type LocationRec, type Production } from './types';

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export const tk = (k: string, vars?: Record<string, string | number>) => t(k as Key, vars);

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const ICON = {
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  trash: svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>'),
  up: svg('<path d="m18 15-6-6-6 6"/>'),
  down: svg('<path d="m6 9 6 6 6-6"/>'),
  left: svg('<path d="m15 18-6-6 6-6"/>'),
  right: svg('<path d="m9 18 6-6-6-6"/>'),
  download: svg('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'),
  wand: svg('<path d="m15 4 5 5"/><path d="M3 21 15 9"/><path d="M19 3v4M17 5h4M9 3v2M8 4h2"/>'),
  open: svg('<path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>'),
  grip: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>',
};

export interface ProdCtx {
  editor: ScreenplayEditor;
  projectId: string | null;
  get(): Production | undefined;
  set(p: Production): void;
  scenes(): SceneInfo[];
  sceneNumbers(): boolean;
  title(): string;
  paper(): 'letter' | 'a4';
  toast(msg: string): void;
  onOpenScene(blockIndex: number): void;
  save(name: string, data: Blob | string, type?: string): Promise<boolean>;
}

/** What every section gets to work with. */
export interface ProdApi {
  ctx: ProdCtx;
  prod(): Production;
  /** Change the production. `render: false` while the user types in a field. */
  update(fn: (p: Production) => void, render?: boolean): void;
  scenes(): SceneInfo[];
  bySid(): Map<string, SceneInfo>;
  cast(): CastRec[];
  locations(): LocationRec[];
  rerender(): void;
  /** Object URL for a stored image (cached). */
  imageUrl(id: string): Promise<string | undefined>;
  cachedUrl(id: string): string | undefined;
  /** Store a picture (downscaled) and return its id. */
  storeImage(file: Blob, maxSide?: number): Promise<string | undefined>;
  money(n: number): string;
  locale(): string;
  /** "Mon 17 Nov" for a YYYY-MM-DD date. */
  dateLabel(date: string | undefined, long?: boolean): string;
  /** Pick image files from the device. */
  pickImages(multiple?: boolean): Promise<File[]>;
}

export interface Section {
  render(): string;
  click?(el: HTMLElement, act: string, e: MouseEvent): void;
  /** After a field edit without re-render: refresh computed numbers. */
  refresh?(root: HTMLElement): void;
  mounted?(root: HTMLElement): void;
  change?(el: HTMLElement): void;
  /** Typing in a field that is not a plain record field. */
  input?(el: HTMLElement): void;
  dragend?(): void;
  drop?(e: DragEvent, root: HTMLElement): boolean;
  dragover?(e: DragEvent, root: HTMLElement): boolean;
  dragstart?(e: DragEvent): boolean;
}

const TABS = ['db', 'schedule', 'callsheet', 'wardrobe', 'budget', 'mood'] as const;
type Tab = (typeof TABS)[number];
const TAB_KEY = 'tewrite:prodTab';

export interface ProductionView {
  render(): void;
  isEditing(): boolean;
}

export function createProduction(root: HTMLElement, ctx: ProdCtx): ProductionView {
  let tab: Tab = 'db';
  try {
    const saved = localStorage.getItem(TAB_KEY) as Tab | null;
    if (saved && TABS.includes(saved)) tab = saved;
  } catch {
    /* ignore */
  }
  const urls = new Map<string, string>();
  let sceneCache: SceneInfo[] | null = null;

  const api: ProdApi = {
    ctx,
    prod: () => ctx.get() ?? emptyProduction(),
    update(fn, render = true) {
      const p = structuredClone(api.prod());
      fn(p);
      ctx.set(p);
      if (render) view.render();
    },
    scenes: () => (sceneCache ??= ctx.scenes()),
    bySid: () => new Map(api.scenes().map((s) => [s.sid, s])),
    cast: () => mergedCast(api.scenes(), api.prod()),
    locations: () => mergedLocations(api.scenes(), api.prod()),
    rerender: () => view.render(),
    async imageUrl(id) {
      if (urls.has(id)) return urls.get(id);
      if (!ctx.projectId) return undefined;
      const blob = await getImage(ctx.projectId, id).catch(() => undefined);
      if (!blob) return undefined;
      const url = URL.createObjectURL(blob);
      urls.set(id, url);
      return url;
    },
    cachedUrl: (id) => urls.get(id),
    async storeImage(file, maxSide = 1400) {
      if (!ctx.projectId) return undefined;
      let bmp: ImageBitmap;
      try {
        bmp = await createImageBitmap(file);
      } catch {
        ctx.toast(tk('sb.imageError'));
        return undefined;
      }
      try {
        const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas');
        c.width = Math.round(bmp.width * s);
        c.height = Math.round(bmp.height * s);
        c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
        bmp.close();
        let blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.86));
        if (!blob || blob.type !== 'image/webp') blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.86));
        if (!blob) return undefined;
        const id = newId();
        await putImage(ctx.projectId, id, blob);
        urls.set(id, URL.createObjectURL(blob));
        return id;
      } catch (err) {
        console.error(err);
        ctx.toast(tk('sb.saveError'));
        return undefined;
      }
    },
    money(n) {
      const currency = api.prod().currency ?? 'IDR';
      try {
        return new Intl.NumberFormat(api.locale(), { style: 'currency', currency, maximumFractionDigits: currency === 'IDR' ? 0 : 2 }).format(n || 0);
      } catch {
        return `${currency} ${Math.round(n || 0).toLocaleString(api.locale())}`;
      }
    },
    locale: () => (getLang() === 'id' ? 'id-ID' : 'en-US'),
    dateLabel(date, long = false) {
      if (!date) return '';
      const d = new Date(`${date}T12:00:00`);
      if (Number.isNaN(d.getTime())) return date;
      return d.toLocaleDateString(api.locale(), long ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' } : { weekday: 'short', day: 'numeric', month: 'short' });
    },
    pickImages(multiple = false) {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = multiple;
        input.addEventListener('change', () => resolve([...(input.files ?? [])]));
        input.click();
      });
    },
  };

  const sections: Record<Tab, Section> = {
    db: createDatabase(api),
    schedule: createSchedule(api),
    callsheet: createCallSheet(api),
    wardrobe: createWardrobe(api),
    budget: createBudget(api),
    mood: createMoodboard(api),
  };

  const panel = () => root.querySelector<HTMLElement>('.pr-panel')!;

  const view: ProductionView = {
    render() {
      sceneCache = null;
      const scrollTop = root.scrollTop;
      root.innerHTML = `
        <div class="pr-tabs" role="tablist" aria-label="${esc(tk('view.prod'))}">
          ${TABS.map((k) => `<button type="button" role="tab" class="pr-tab" data-tab="${k}" aria-selected="${k === tab}">${esc(tk(`pr.tab.${k}`))}</button>`).join('')}
        </div>
        <div class="pr-panel" role="tabpanel" data-section="${tab}">${sections[tab].render()}</div>`;
      root.scrollTop = scrollTop;
      sections[tab].mounted?.(panel());
      // Pictures that are not loaded yet.
      for (const img of root.querySelectorAll<HTMLImageElement>('img[data-img]:not([src])')) {
        void api.imageUrl(img.dataset.img!).then((u) => {
          if (u && img.isConnected) img.src = u;
        });
      }
    },
    isEditing() {
      const a = document.activeElement;
      return Boolean(a && root.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT'));
    },
  };

  /* ---------------- generic field binding ---------------- */

  type Coll = 'locations' | 'cast' | 'crew' | 'days' | 'wardrobe' | 'budget';
  function writeField(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, render: boolean) {
    const f = el.dataset.f;
    const row = el.closest<HTMLElement>('[data-coll][data-id]');
    if (!f || !row) return false;
    const coll = row.dataset.coll as Coll;
    let id = row.dataset.id!;
    const raw = el.value;
    const value: unknown = el.dataset.num !== undefined ? (raw.trim() === '' ? undefined : Number(raw.replace(',', '.'))) : raw;
    api.update((p) => {
      const list = p[coll] as unknown as Record<string, unknown>[];
      let rec = list.find((r) => r.id === id);
      if (!rec && isDerived(id)) {
        // First edit of a character / location the script implied: make it a record.
        const fresh = newId();
        rec = coll === 'cast' ? { id: fresh, character: row.dataset.key } : { id: fresh, name: row.dataset.key };
        list.push(rec);
        for (const r of root.querySelectorAll<HTMLElement>(`[data-coll="${coll}"][data-id="${CSS.escape(id)}"]`)) r.dataset.id = fresh;
        id = fresh;
      }
      if (!rec) return;
      if (value === undefined || value === '' || (typeof value === 'number' && !Number.isFinite(value))) delete rec[f];
      else rec[f] = value;
    }, render);
    return true;
  }

  root.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'file') return;
    if (writeField(el, false)) sections[tab].refresh?.(panel());
    else sections[tab].input?.(el);
  });
  root.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.tagName === 'SELECT' && el.dataset.f) writeField(el, true);
    else if (el.tagName === 'INPUT' && el.dataset.f && (el.type === 'date' || el.type === 'time' || el.dataset.num !== undefined)) {
      writeField(el, false);
      sections[tab].refresh?.(panel());
    } else sections[tab].change?.(el);
  });

  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const tabBtn = target.closest<HTMLElement>('[data-tab]');
    if (tabBtn) {
      tab = tabBtn.dataset.tab as Tab;
      try {
        localStorage.setItem(TAB_KEY, tab);
      } catch {
        /* ignore */
      }
      root.scrollTop = 0;
      view.render();
      root.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus();
      return;
    }
    const btn = target.closest<HTMLElement>('[data-act]');
    if (btn && !(btn as HTMLButtonElement).disabled) sections[tab].click?.(btn, btn.dataset.act!, e);
  });
  root.addEventListener('keydown', (e) => {
    // Arrow keys move between sub-tabs.
    const tabBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
    if (!tabBtn || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
    const k = (TABS.indexOf(tabBtn.dataset.tab as Tab) + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
    root.querySelector<HTMLElement>(`[data-tab="${TABS[k]}"]`)?.click();
  });
  root.addEventListener('dragstart', (e) => {
    sections[tab].dragstart?.(e);
  });
  root.addEventListener('dragover', (e) => {
    if (sections[tab].dragover?.(e, panel())) e.preventDefault();
  });
  root.addEventListener('drop', (e) => {
    if (sections[tab].drop?.(e, panel())) e.preventDefault();
  });
  root.addEventListener('dragend', () => {
    root.querySelectorAll('.drop-before, .drop-after, .drop-into, .dragging').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-into', 'dragging'));
    sections[tab].dragend?.();
  });

  return view;
}

/* ---------------- small HTML helpers for the sections ---------------- */

export const field = (f: string, label: string, value: string | number | undefined, o: { type?: string; num?: boolean; ph?: string; wide?: boolean; area?: boolean; list?: string } = {}) => {
  const v = value === undefined || value === null ? '' : String(value);
  const attrs = `data-f="${f}"${o.num ? ' data-num' : ''} placeholder="${esc(o.ph ?? '')}" aria-label="${esc(label)}"${o.list ? ` list="${o.list}"` : ''}`;
  const control = o.area
    ? `<textarea ${attrs} rows="2">${esc(v)}</textarea>`
    : `<input ${attrs} type="${o.type ?? (o.num ? 'number' : 'text')}"${o.num ? ' min="0" step="any" inputmode="decimal"' : ''} value="${esc(v)}" autocomplete="off" />`;
  return `<label class="pr-field${o.wide ? ' is-wide' : ''}"><span>${esc(label)}</span>${control}</label>`;
};

export const button = (act: string, label: string, icon = '', cls = 'btn btn-sm', extra = '') =>
  `<button type="button" class="${cls}" data-act="${act}" ${extra}>${icon}<span>${esc(label)}</span></button>`;

export const iconButton = (act: string, label: string, icon: string, extra = '') =>
  `<button type="button" class="pr-icon" data-act="${act}" title="${esc(label)}" aria-label="${esc(label)}" ${extra}>${icon}</button>`;
