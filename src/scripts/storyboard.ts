/**
 * Storyboard view: every scene of the script gets a row of panels (shots).
 * A panel has a drawing (see sketch.ts), shot size, angle, camera movement,
 * duration and a note. Panel data lives on the scene block (`board`), so it
 * moves with the scene, is undoable and is saved with the project; drawings
 * live in the image store (projects.ts) and are referenced by id.
 */
import type { ScreenplayEditor } from './editor';
import { t, type Key } from './i18n';
import { getImage, newId, putImage } from './projects';
import { imageToPanel, openSketch } from './sketch';
import {
  ASPECT_RATIO,
  BOARD_ASPECTS,
  CAMERA_MOVES,
  SHOT_ABBR,
  SHOT_ANGLES,
  SHOT_SIZES,
  type BoardAspect,
  type Block,
  type Panel,
} from './types';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const svg = (body: string, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;
const ICON = {
  open: svg('<path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  pencil: svg('<path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'),
  copy: svg('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a2 2 0 0 1 2-2h11"/>'),
  left: svg('<path d="m15 18-6-6 6-6"/>'),
  right: svg('<path d="m9 18 6-6-6-6"/>'),
  trash: svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>'),
  pdf: svg('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>'),
  grip: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>',
};

export interface Storyboard {
  render(): void;
  /** True while the user is typing in a panel (don't re-render under them). */
  isEditing(): boolean;
  focusScene(blockIndex: number): void;
}

export interface StoryboardOptions {
  projectId: string | null;
  sceneNumbers: () => boolean;
  sceneLabels: (blocks: Block[]) => Map<number, string>;
  aspect: () => BoardAspect;
  setAspect: (a: BoardAspect) => void;
  onOpenScene: (blockIndex: number) => void;
  onExport: () => void;
  toast: (msg: string) => void;
}

/** Number shown on a panel: scene 12, third shot → "12.3". */
export const panelLabel = (scene: string | number | null, k: number) => (scene ? `${scene}.${k + 1}` : String(k + 1));

export function createStoryboard(root: HTMLElement, editor: ScreenplayEditor, opts: StoryboardOptions): Storyboard {
  /** Object URLs of drawings already loaded, by image id. */
  const urls = new Map<string, string>();
  let drag: { scene: number; id: string } | null = null;

  const boardOf = (scene: number): Panel[] => structuredClone(editor.getBlocks()[scene]?.board ?? []);
  const save = (scene: number, board: Panel[], typing = false) => editor.updateBlock(scene, { board }, typing);

  async function blobOf(id: string | undefined): Promise<Blob | undefined> {
    if (!id || !opts.projectId) return undefined;
    return getImage(opts.projectId, id).catch(() => undefined);
  }

  /** Fill in drawings that aren't loaded yet. */
  async function loadImages() {
    for (const img of root.querySelectorAll<HTMLImageElement>('img[data-img]:not([src])')) {
      const id = img.dataset.img!;
      let url = urls.get(id);
      if (!url) {
        const blob = await blobOf(id);
        if (!blob) {
          img.closest('.sb-frame')?.classList.add('is-missing');
          continue;
        }
        url = URL.createObjectURL(blob);
        urls.set(id, url);
      }
      if (img.isConnected) img.src = url;
    }
  }

  const option = (value: string, label: string, selected: boolean) =>
    `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;

  function panelHtml(p: Panel, scene: number, k: number, label: string) {
    const url = p.img ? urls.get(p.img) : undefined;
    const frame = p.img
      ? `<img data-img="${esc(p.img)}" alt="${esc(t('sb.panel', { n: label }))}"${url ? ` src="${url}"` : ''} draggable="false" />`
      : `<span class="sb-empty">${ICON.pencil}<span>${esc(t('sb.draw'))}</span></span>`;
    return `<li class="sb-panel" draggable="true" data-id="${esc(p.id)}" data-scene="${scene}">
      <div class="sb-frame${p.img ? '' : ' is-blank'}">
        <button type="button" class="sb-draw" data-act="draw" aria-label="${esc(t('sb.drawLabel', { n: label }))}">${frame}</button>
        <span class="sb-no">${esc(label)}</span>
        <div class="sb-acts">
          <button type="button" class="sb-act" data-act="duplicate" title="${esc(t('sb.duplicate'))}" aria-label="${esc(t('sb.duplicate'))}">${ICON.copy}</button>
          <button type="button" class="sb-act" data-act="earlier" title="${esc(t('sb.earlier'))}" aria-label="${esc(t('sb.earlier'))}">${ICON.left}</button>
          <button type="button" class="sb-act" data-act="later" title="${esc(t('sb.later'))}" aria-label="${esc(t('sb.later'))}">${ICON.right}</button>
          <button type="button" class="sb-act sb-act-danger" data-act="delete" title="${esc(t('sb.delete'))}" aria-label="${esc(t('sb.delete'))}">${ICON.trash}</button>
        </div>
      </div>
      <div class="sb-meta">
        <select class="sb-sel sb-sel-shot" data-field="shot" aria-label="${esc(t('sb.shot'))}" title="${esc(t('sb.shot'))}">
          ${option('', t('sb.shot'), !p.shot)}
          ${SHOT_SIZES.map((s) => option(s, `${SHOT_ABBR[s]} · ${t(`sb.shot.${s}` as Key)}`, p.shot === s)).join('')}
        </select>
        <select class="sb-sel" data-field="angle" aria-label="${esc(t('sb.angle'))}" title="${esc(t('sb.angle'))}">
          ${option('', t('sb.angle'), !p.angle)}
          ${SHOT_ANGLES.map((a) => option(a, t(`sb.angle.${a}` as Key), p.angle === a)).join('')}
        </select>
        <select class="sb-sel" data-field="move" aria-label="${esc(t('sb.move'))}" title="${esc(t('sb.move'))}">
          ${option('', t('sb.move'), !p.move)}
          ${CAMERA_MOVES.map((m) => option(m, t(`sb.move.${m}` as Key), p.move === m)).join('')}
        </select>
        <input class="sb-dur" data-field="dur" value="${esc(p.dur ?? '')}" placeholder="${esc(t('sb.durPh'))}" aria-label="${esc(t('sb.dur'))}" title="${esc(t('sb.dur'))}" autocomplete="off" spellcheck="false" maxlength="20" />
      </div>
      <textarea class="sb-note" data-field="note" rows="3" placeholder="${esc(t('sb.notePh'))}" aria-label="${esc(t('sb.noteLabel', { n: label }))}">${esc(p.note ?? '')}</textarea>
    </li>`;
  }

  function render() {
    const blocks = editor.getBlocks();
    const labels = opts.sceneLabels(blocks);
    const numbers = opts.sceneNumbers();
    const aspect = opts.aspect();
    const parts: string[] = [];
    let scenes = 0;
    let panels = 0;
    blocks.forEach((b, i) => {
      if (b.type !== 'scene') return;
      scenes++;
      const no = labels.get(i) ?? String(scenes);
      const board = b.board ?? [];
      panels += board.length;
      parts.push(`<section class="sb-scene" data-block="${i}"${b.color ? ` data-color="${esc(b.color)}"` : ''}>
        <header class="sb-scene-head">
          ${numbers ? `<span class="sb-scene-no">${esc(no)}</span>` : ''}
          <h3 class="sb-heading">${esc(b.text.trim().toUpperCase() || t('nav.untitledScene'))}</h3>
          <span class="sb-count">${esc(board.length === 1 ? t('sb.panels1') : t('sb.panels', { n: board.length }))}</span>
          <button type="button" class="scard-btn" data-act="open" title="${esc(t('cards.open'))}" aria-label="${esc(t('cards.open'))}">${ICON.open}</button>
        </header>
        ${b.synopsis?.trim() ? `<p class="sb-syn">${esc(b.synopsis.trim())}</p>` : ''}
        <ol class="sb-panels">
          ${board.map((p, k) => panelHtml(p, i, k, panelLabel(numbers ? no : null, k))).join('')}
          <li class="sb-add-cell"><button type="button" class="sb-add" data-act="add" data-scene="${i}">${ICON.plus}<span>${esc(t('sb.add'))}</span></button></li>
        </ol>
      </section>`);
    });

    root.style.setProperty('--sb-ar', String(ASPECT_RATIO[aspect]));
    root.dataset.aspect = aspect;
    root.innerHTML = `
      <div class="sb-head">
        <p class="text-muted text-sm sb-hint">${esc(scenes ? t('sb.hint') : t('sb.empty'))}</p>
        <label class="sb-aspect"><span>${esc(t('sb.frame'))}</span>
          <select data-aspect>${BOARD_ASPECTS.map((a) => option(a, t(`sb.aspect.${a}` as Key), a === aspect)).join('')}</select>
        </label>
        <span class="text-muted text-sm whitespace-nowrap">${esc(panels === 1 ? t('sb.panels1') : t('sb.panels', { n: panels }))}</span>
        <button type="button" class="btn btn-icon sb-export" data-act="export"${panels ? '' : ' disabled'}>${ICON.pdf}<span>${esc(t('sb.export'))}</span></button>
      </div>
      <div class="sb-scenes">${parts.join('')}</div>`;
    void loadImages();
  }

  /* ---------------- panel operations ---------------- */

  const panelEl = (scene: number, id: string) => root.querySelector<HTMLElement>(`.sb-panel[data-scene="${scene}"][data-id="${CSS.escape(id)}"]`);

  function addPanel(scene: number) {
    const board = boardOf(scene);
    const last = board[board.length - 1];
    board.push({ id: newId(), ...(last?.shot ? { shot: last.shot } : {}), ...(last?.angle ? { angle: last.angle } : {}) });
    save(scene, board);
    render();
    const el = panelEl(scene, board[board.length - 1].id);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    el?.querySelector<HTMLElement>('.sb-draw')?.focus({ preventScroll: true });
  }

  /** Store a new drawing for a panel (a drawing is never overwritten, see projects.ts). */
  async function setDrawing(scene: number, id: string, blob: Blob) {
    if (!opts.projectId) return;
    const img = newId();
    try {
      await putImage(opts.projectId, img, blob);
    } catch (err) {
      console.error(err);
      opts.toast(t('sb.saveError'));
      return;
    }
    urls.set(img, URL.createObjectURL(blob));
    const board = boardOf(scene);
    const p = board.find((x) => x.id === id);
    if (!p) return;
    p.img = img;
    save(scene, board);
    render();
    panelEl(scene, id)?.querySelector<HTMLElement>('.sb-draw')?.focus({ preventScroll: true });
  }

  async function draw(scene: number, id: string) {
    const blocks = editor.getBlocks();
    const board = blocks[scene]?.board ?? [];
    const k = board.findIndex((x) => x.id === id);
    if (k < 0) return;
    // The panel before this one (in this scene or the end of an earlier one), for the onion skin.
    let prev: Panel | undefined = board[k - 1];
    for (let i = scene - 1; !prev && i >= 0; i--) if (blocks[i].type === 'scene' && blocks[i].board?.length) prev = blocks[i].board!.at(-1);
    const labels = opts.sceneLabels(blocks);
    let n = 0;
    for (let i = 0; i <= scene; i++) if (blocks[i].type === 'scene') n++;
    const label = panelLabel(opts.sceneNumbers() ? (labels.get(scene) ?? n) : null, k);
    const blob = await openSketch({
      aspect: ASPECT_RATIO[opts.aspect()],
      title: t('sb.panel', { n: label }),
      image: await blobOf(board[k].img),
      previous: await blobOf(prev?.img),
    });
    if (blob) await setDrawing(scene, id, blob);
    else panelEl(scene, id)?.querySelector<HTMLElement>('.sb-draw')?.focus({ preventScroll: true });
  }

  function duplicate(scene: number, id: string) {
    const board = boardOf(scene);
    const k = board.findIndex((x) => x.id === id);
    if (k < 0) return;
    // Drawings never change once stored, so the copy can share it.
    board.splice(k + 1, 0, { ...board[k], id: newId() });
    save(scene, board);
    render();
    panelEl(scene, board[k + 1].id)?.querySelector<HTMLElement>('.sb-draw')?.focus({ preventScroll: true });
  }

  function remove(scene: number, id: string) {
    const board = boardOf(scene);
    const k = board.findIndex((x) => x.id === id);
    const p = board[k];
    if (!p) return;
    if ((p.img || p.note?.trim()) && !confirm(t('sb.confirmDelete'))) return;
    board.splice(k, 1);
    save(scene, board);
    render();
    const next = board[Math.min(k, board.length - 1)];
    (next ? panelEl(scene, next.id)?.querySelector<HTMLElement>('.sb-draw') : root.querySelector<HTMLElement>(`.sb-add[data-scene="${scene}"]`))?.focus({ preventScroll: true });
  }

  /** Move a panel to another place, in its own scene or another one (one undo step). */
  function move(from: { scene: number; id: string }, toScene: number, beforeId: string | null) {
    const blocks = editor.getBlocks();
    const src = structuredClone(blocks[from.scene]?.board ?? []);
    const k = src.findIndex((x) => x.id === from.id);
    if (k < 0 || blocks[toScene]?.type !== 'scene') return;
    const [p] = src.splice(k, 1);
    const dst = toScene === from.scene ? src : structuredClone(blocks[toScene].board ?? []);
    const at = beforeId ? dst.findIndex((x) => x.id === beforeId) : -1;
    dst.splice(at < 0 ? dst.length : at, 0, p);
    if (toScene === from.scene) save(toScene, dst);
    else
      editor.updateBlocks(
        new Map([
          [from.scene, { board: src }],
          [toScene, { board: dst }],
        ]),
      );
    render();
  }

  function step(scene: number, id: string, dir: -1 | 1) {
    const board = boardOf(scene);
    const k = board.findIndex((x) => x.id === id);
    const j = k + dir;
    if (k < 0 || j < 0 || j >= board.length) return;
    [board[k], board[j]] = [board[j], board[k]];
    save(scene, board);
    render();
    panelEl(scene, id)?.querySelector<HTMLElement>(`[data-act="${dir < 0 ? 'earlier' : 'later'}"]`)?.focus({ preventScroll: true });
  }

  /* ---------------- events ---------------- */

  const target = (el: Element) => {
    const li = el.closest<HTMLElement>('.sb-panel');
    return li ? { scene: Number(li.dataset.scene), id: li.dataset.id! } : null;
  };

  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn || (btn as HTMLButtonElement).disabled) return;
    const act = btn.dataset.act;
    if (act === 'export') return opts.onExport();
    if (act === 'add') return addPanel(Number(btn.dataset.scene));
    if (act === 'open') return opts.onOpenScene(Number(btn.closest<HTMLElement>('.sb-scene')!.dataset.block));
    const p = target(btn);
    if (!p) return;
    if (!opts.projectId) return;
    if (act === 'draw') void draw(p.scene, p.id);
    else if (act === 'duplicate') duplicate(p.scene, p.id);
    else if (act === 'delete') remove(p.scene, p.id);
    else if (act === 'earlier') step(p.scene, p.id, -1);
    else if (act === 'later') step(p.scene, p.id, 1);
  });

  const fieldChanged = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, typing: boolean) => {
    if (el.matches('[data-aspect]')) {
      opts.setAspect(el.value as BoardAspect);
      root.style.setProperty('--sb-ar', String(ASPECT_RATIO[el.value as BoardAspect]));
      root.dataset.aspect = el.value;
      return;
    }
    const field = el.dataset.field as 'shot' | 'angle' | 'move' | 'dur' | 'note' | undefined;
    const p = target(el);
    if (!field || !p) return;
    const board = boardOf(p.scene);
    const panel = board.find((x) => x.id === p.id);
    if (!panel) return;
    const value = field === 'note' ? el.value : el.value.trim();
    if (value.trim()) (panel as unknown as Record<string, string>)[field] = value;
    else delete panel[field];
    save(p.scene, board, typing);
  };
  root.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement | HTMLTextAreaElement;
    if (el.tagName !== 'SELECT') fieldChanged(el, true);
  });
  root.addEventListener('change', (e) => {
    const el = e.target as HTMLSelectElement;
    if (el.tagName === 'SELECT') fieldChanged(el, false);
  });
  root.addEventListener('focusout', () => editor.flush());

  // Drag & drop: panels between places; image files onto a frame.
  root.addEventListener('mousedown', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('.sb-panel');
    if (li) li.draggable = !(e.target as HTMLElement).closest('input, textarea, select');
  });
  root.addEventListener('dragstart', (e) => {
    const p = target(e.target as HTMLElement);
    if (!p) return;
    drag = p;
    (e.target as HTMLElement).closest('.sb-panel')?.classList.add('dragging');
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', p.id);
  });
  const clearMarks = () => root.querySelectorAll('.drop-before, .drop-after, .drop-into, .dragging').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-into', 'dragging'));
  const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  function dropPlace(e: DragEvent) {
    const el = e.target as HTMLElement;
    const li = el.closest<HTMLElement>('.sb-panel');
    if (li) {
      const r = li.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      const scene = Number(li.dataset.scene);
      const next = before ? li : (li.nextElementSibling as HTMLElement | null);
      return { el: li, before, scene, beforeId: next?.classList.contains('sb-panel') ? next.dataset.id! : null };
    }
    const add = el.closest<HTMLElement>('.sb-add-cell');
    if (add) return { el: add, before: true, scene: Number(add.querySelector<HTMLElement>('.sb-add')!.dataset.scene), beforeId: null };
    return null;
  }
  root.addEventListener('dragover', (e) => {
    if (hasFiles(e)) {
      const frame = (e.target as HTMLElement).closest('.sb-frame');
      if (!frame) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
      root.querySelectorAll('.drop-into').forEach((x) => x !== frame && x.classList.remove('drop-into'));
      frame.classList.add('drop-into');
      return;
    }
    if (!drag) return;
    const place = dropPlace(e);
    if (!place) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    root.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    place.el.classList.add(place.before ? 'drop-before' : 'drop-after');
  });
  root.addEventListener('dragleave', (e) => {
    const frame = (e.target as HTMLElement).closest('.sb-frame');
    if (frame && !frame.contains(e.relatedTarget as Node)) frame.classList.remove('drop-into');
  });
  root.addEventListener('drop', async (e) => {
    if (hasFiles(e)) {
      const p = target(e.target as HTMLElement);
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
      e.preventDefault();
      clearMarks();
      if (!p || !file || !opts.projectId) return;
      try {
        await setDrawing(p.scene, p.id, await imageToPanel(file, ASPECT_RATIO[opts.aspect()]));
      } catch {
        opts.toast(t('sb.imageError'));
      }
      return;
    }
    const place = dropPlace(e);
    const from = drag;
    e.preventDefault();
    clearMarks();
    drag = null;
    if (place && from && !(place.scene === from.scene && place.beforeId === from.id)) move(from, place.scene, place.beforeId);
  });
  root.addEventListener('dragend', () => {
    clearMarks();
    drag = null;
  });

  return {
    render,
    isEditing: () => {
      const a = document.activeElement;
      return Boolean(a && root.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'));
    },
    focusScene(blockIndex: number) {
      const sec = root.querySelector<HTMLElement>(`.sb-scene[data-block="${blockIndex}"]`);
      if (!sec) return;
      sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
      sec.classList.add('flash');
      setTimeout(() => sec.classList.remove('flash'), 900);
    },
  };
}
