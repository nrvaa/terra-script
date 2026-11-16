/**
 * Storyboard drawing editor: a full-screen dialog with a canvas in the
 * project's frame shape.
 *  - Pencil, brush, grey marker for shading, eraser
 *  - Line, arrow (camera / character movement), rectangle, ellipse
 *  - Pressure from a stylus; once a pen is used, touches are ignored (palm rejection)
 *  - Import a photo or reference image, show the previous panel faintly
 *    (onion skin) and a rule-of-thirds guide
 * The result is one flat image on white "paper". Everything drawn is kept as
 * a list of operations, so undo/redo simply replays them.
 */
import { t, type Key } from './i18n';

type DrawTool = 'pencil' | 'brush' | 'marker' | 'eraser';
type ShapeTool = 'line' | 'arrow' | 'rect' | 'ellipse';
type Tool = DrawTool | ShapeTool;

interface StrokeOp {
  kind: 'stroke';
  tool: DrawTool;
  color: string;
  size: number;
  /** x, y, pressure triples. */
  pts: number[];
}
interface ShapeOp {
  kind: 'shape';
  tool: ShapeTool;
  color: string;
  size: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface ImageOp {
  kind: 'image';
  bmp: ImageBitmap;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface ClearOp {
  kind: 'clear';
}
type Op = StrokeOp | ShapeOp | ImageOp | ClearOp;

const PAPER = '#ffffff';
const COLORS = ['#1b1b1f', '#6b6f78', '#b8bcc4', '#ffffff', '#e5484d', '#0090ff', '#30a46c', '#f2b705'];
const DEFAULT_SIZE: Record<Tool, number> = { pencil: 4, brush: 12, marker: 34, eraser: 44, line: 5, arrow: 6, rect: 5, ellipse: 5 };
const KEYS: Record<string, Tool> = { p: 'pencil', b: 'brush', m: 'marker', e: 'eraser', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse' };
const PREFS_KEY = 'tewrite:sketch';

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS: Record<string, string> = {
  pencil: svg('<path d="M17 3a2.85 2.85 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'),
  brush: svg('<path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/>'),
  marker: svg('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
  eraser: svg('<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>'),
  line: svg('<path d="M5 19 19 5"/>'),
  arrow: svg('<path d="M5 19 19 5"/><path d="M10 5h9v9"/>'),
  rect: svg('<rect x="3.5" y="5.5" width="17" height="13" rx="1"/>'),
  ellipse: svg('<ellipse cx="12" cy="12" rx="9" ry="6.5"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>'),
  onion: svg('<rect x="2.5" y="6.5" width="13" height="11" rx="1.5"/><rect x="8.5" y="3.5" width="13" height="11" rx="1.5" stroke-dasharray="2.5 2.5"/>'),
  grid: svg('<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M9 5v14M15 5v14M3 9.67h18M3 14.33h18"/>'),
  clear: svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>'),
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

interface Prefs {
  tool: Tool;
  color: string;
  sizes: Partial<Record<Tool, number>>;
  grid: boolean;
  onion: boolean;
}
function loadPrefs(): Prefs {
  const base: Prefs = { tool: 'pencil', color: COLORS[0], sizes: {}, grid: false, onion: true };
  try {
    return { ...base, ...(JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Partial<Prefs>) };
  } catch {
    return base;
  }
}
function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/** Canvas size for a frame shape: the long side is 1600 px. */
export function frameSize(aspect: number): { w: number; h: number } {
  return aspect >= 1 ? { w: 1600, h: Math.round(1600 / aspect) } : { w: Math.round(1600 * aspect), h: 1600 };
}

/** Where an image of size iw × ih sits inside the frame, fitted whole and centred. */
function fit(iw: number, ih: number, w: number, h: number) {
  const s = Math.min(w / iw, h / ih);
  return { w: iw * s, h: ih * s, x: (w - iw * s) / 2, y: (h - ih * s) / 2 };
}

/** Encode the canvas: WebP where the browser can, PNG otherwise. */
export async function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  const webp = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.9));
  if (webp && webp.type === 'image/webp') return webp;
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/png'));
}

/** An image file turned into a panel drawing: fitted into the frame on white paper. */
export async function imageToPanel(file: Blob, aspect: number): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const { w, h } = frameSize(aspect);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = PAPER;
  g.fillRect(0, 0, w, h);
  const f = fit(bmp.width, bmp.height, w, h);
  g.drawImage(bmp, f.x, f.y, f.w, f.h);
  bmp.close();
  return canvasBlob(c);
}

export interface SketchOptions {
  /** Width / height of the frame. */
  aspect: number;
  title: string;
  /** The panel's current drawing. */
  image?: Blob;
  /** The previous panel, for the onion skin. */
  previous?: Blob;
}

let dialog: HTMLDialogElement | null = null;

/** Open the editor. Resolves to the new drawing, or null when cancelled / unchanged. */
export function openSketch(opts: SketchOptions): Promise<Blob | null> {
  dialog?.remove();
  const prefs = loadPrefs();
  const { w: W, h: H } = frameSize(opts.aspect);

  const d = document.createElement('dialog');
  dialog = d;
  d.className = 'sk-dialog';
  d.setAttribute('aria-labelledby', 'sk-title');
  const toolBtn = (tool: Tool) => {
    const key = Object.entries(KEYS).find(([, v]) => v === tool)![0].toUpperCase();
    const label = t(`sk.${tool}` as Key);
    return `<button type="button" class="sk-btn" data-tool="${tool}" aria-pressed="false" title="${esc(label)} (${key})" aria-label="${esc(label)}">${ICONS[tool]}</button>`;
  };
  const actBtn = (act: string, key: Key, shortcut = '') =>
    `<button type="button" class="sk-btn" data-act="${act}" title="${esc(t(key))}${shortcut ? ` (${shortcut})` : ''}" aria-label="${esc(t(key))}">${ICONS[act]}</button>`;
  d.innerHTML = `
    <div class="sk-shell">
      <header class="sk-head">
        <h2 id="sk-title">${esc(opts.title)}</h2>
        <span class="sk-hint">${esc(t('sk.hint'))}</span>
        <div class="sk-head-btns">
          <button type="button" class="btn" data-act="cancel">${esc(t('proj.cancel'))}</button>
          <button type="button" class="btn btn-primary" data-act="save"><span>${esc(t('sk.save'))}</span></button>
        </div>
      </header>
      <div class="sk-body">
        <div class="sk-tools" role="toolbar" aria-label="${esc(t('sk.tools'))}">
          ${(['pencil', 'brush', 'marker', 'eraser'] as Tool[]).map(toolBtn).join('')}
          <span class="sk-sep" aria-hidden="true"></span>
          ${(['line', 'arrow', 'rect', 'ellipse'] as Tool[]).map(toolBtn).join('')}
          <span class="sk-sep" aria-hidden="true"></span>
          ${actBtn('undo', 'sk.undo', 'Ctrl+Z')}
          ${actBtn('redo', 'sk.redo', 'Ctrl+Y')}
          <span class="sk-sep" aria-hidden="true"></span>
          ${actBtn('image', 'sk.image')}
          ${opts.previous ? `<button type="button" class="sk-btn" data-act="onion" aria-pressed="${prefs.onion}" title="${esc(t('sk.onion'))}" aria-label="${esc(t('sk.onion'))}">${ICONS.onion}</button>` : ''}
          <button type="button" class="sk-btn" data-act="grid" aria-pressed="${prefs.grid}" title="${esc(t('sk.grid'))}" aria-label="${esc(t('sk.grid'))}">${ICONS.grid}</button>
          ${actBtn('clear', 'sk.clear')}
        </div>
        <div class="sk-stage">
          <div class="sk-frame" style="aspect-ratio: ${W} / ${H}; --ar: ${W / H}">
            <canvas width="${W}" height="${H}"></canvas>
            <img class="sk-onion" alt="" hidden />
            <svg class="sk-grid" viewBox="0 0 3 3" preserveAspectRatio="none" aria-hidden="true" hidden><path d="M1 0v3M2 0v3M0 1h3M0 2h3" vector-effect="non-scaling-stroke"/></svg>
          </div>
        </div>
        <div class="sk-props">
          <div class="sk-colors" role="radiogroup" aria-label="${esc(t('sk.color'))}">
            ${COLORS.map((c) => `<button type="button" class="sk-swatch" role="radio" data-color="${c}" style="--sw:${c}" aria-checked="false" aria-label="${c}"></button>`).join('')}
            <label class="sk-custom" title="${esc(t('sk.customColor'))}"><input type="color" value="${prefs.color}" aria-label="${esc(t('sk.customColor'))}" /></label>
          </div>
          <label class="sk-size"><span>${esc(t('sk.size'))}</span><input type="range" min="1" max="120" step="1" /><i class="sk-size-dot" aria-hidden="true"></i></label>
        </div>
      </div>
      <input type="file" accept="image/*" hidden />
    </div>`;
  document.body.appendChild(d);

  const canvas = d.querySelector('canvas')!;
  const g = canvas.getContext('2d')!;
  const committed = document.createElement('canvas');
  committed.width = W;
  committed.height = H;
  const cg = committed.getContext('2d')!;
  const scratch = document.createElement('canvas');
  scratch.width = W;
  scratch.height = H;
  const sg = scratch.getContext('2d')!;
  const onionImg = d.querySelector<HTMLImageElement>('.sk-onion')!;
  const gridSvg = d.querySelector<SVGElement>('.sk-grid')!;
  const sizeInput = d.querySelector<HTMLInputElement>('.sk-size input')!;
  const sizeDot = d.querySelector<HTMLElement>('.sk-size-dot')!;
  const colorInput = d.querySelector<HTMLInputElement>('.sk-custom input')!;
  const fileInput = d.querySelector<HTMLInputElement>('input[type=file]')!;

  let ops: Op[] = [];
  let redoStack: Op[] = [];
  /** Ops before this index came with the panel (not undoable). */
  let baseOps = 0;
  let dirty = false;
  let current: StrokeOp | ShapeOp | null = null;
  let activePointer: number | null = null;
  let penSeen = false;
  let onionUrl = '';

  /* ---------------- painting ---------------- */

  function paintStroke(ctx: CanvasRenderingContext2D, op: StrokeOp, from = 0) {
    const p = op.pts;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = op.tool === 'eraser' ? PAPER : op.color;
    if (op.tool === 'marker') {
      // Constant width, drawn as one path so overlaps inside a stroke don't darken.
      ctx.lineWidth = op.size;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      for (let i = 3; i < p.length; i += 3) ctx.lineTo(p[i], p[i + 1]);
      if (p.length === 3) ctx.lineTo(p[0] + 0.01, p[1]);
      ctx.stroke();
    } else {
      const k = op.tool === 'pencil' ? 0.55 : op.tool === 'brush' ? 1.1 : 0;
      const width = (pr: number) => Math.max(0.6, op.size * (k ? 1 - k / 2 + pr * k : 1));
      if (p.length === 3) {
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.arc(p[0], p[1], width(p[2]) / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let i = Math.max(3, from); i < p.length; i += 3) {
        ctx.lineWidth = width((p[i - 1] + p[i + 2]) / 2);
        ctx.beginPath();
        ctx.moveTo(p[i - 3], p[i - 2]);
        ctx.lineTo(p[i], p[i + 1]);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function paintShape(ctx: CanvasRenderingContext2D, op: ShapeOp) {
    const { x0, y0, x1, y1 } = op;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = op.size;
    ctx.strokeStyle = op.color;
    ctx.beginPath();
    if (op.tool === 'rect') ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    else if (op.tool === 'ellipse') {
      ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
    } else {
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      if (op.tool === 'arrow' && Math.hypot(x1 - x0, y1 - y0) > 4) {
        const a = Math.atan2(y1 - y0, x1 - x0);
        const head = Math.max(18, op.size * 4.5);
        for (const s of [-1, 1]) {
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 - head * Math.cos(a + (s * Math.PI) / 7), y1 - head * Math.sin(a + (s * Math.PI) / 7));
        }
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  function paintOp(ctx: CanvasRenderingContext2D, op: Op) {
    if (op.kind === 'clear') {
      ctx.fillStyle = PAPER;
      ctx.fillRect(0, 0, W, H);
    } else if (op.kind === 'image') ctx.drawImage(op.bmp, op.x, op.y, op.w, op.h);
    else if (op.kind === 'shape') paintShape(ctx, op);
    else if (op.tool === 'marker') {
      // Semi-transparent: draw at full strength off-screen, then lay it down once.
      sg.clearRect(0, 0, W, H);
      paintStroke(sg, op);
      ctx.save();
      ctx.globalAlpha = 0.38;
      ctx.drawImage(scratch, 0, 0);
      ctx.restore();
    } else paintStroke(ctx, op);
  }

  function rebuild() {
    cg.fillStyle = PAPER;
    cg.fillRect(0, 0, W, H);
    for (const op of ops) paintOp(cg, op);
    show();
  }
  /** Committed drawing + the operation in progress. */
  function show(preview?: Op) {
    g.drawImage(committed, 0, 0);
    if (preview) paintOp(g, preview);
  }

  /* ---------------- tools & props ---------------- */

  const sizeOf = (tool: Tool) => prefs.sizes[tool] ?? DEFAULT_SIZE[tool];
  function setTool(tool: Tool) {
    prefs.tool = tool;
    for (const b of d.querySelectorAll<HTMLElement>('[data-tool]')) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    sizeInput.value = String(sizeOf(tool));
    updateSizeDot();
    canvas.dataset.tool = tool;
  }
  function setColor(color: string) {
    prefs.color = color;
    for (const b of d.querySelectorAll<HTMLElement>('.sk-swatch')) b.setAttribute('aria-checked', String(b.dataset.color === color));
    if (/^#[0-9a-f]{6}$/i.test(color)) colorInput.value = color;
    updateSizeDot();
  }
  function updateSizeDot() {
    const shown = Math.max(3, Math.min(40, Number(sizeInput.value) * (canvas.clientWidth / W || 0.5)));
    sizeDot.style.width = sizeDot.style.height = `${shown}px`;
    sizeDot.style.background = prefs.tool === 'eraser' ? 'transparent' : prefs.color;
  }
  function setSize(n: number) {
    n = Math.max(1, Math.min(120, Math.round(n)));
    prefs.sizes[prefs.tool] = n;
    sizeInput.value = String(n);
    updateSizeDot();
  }
  function setToggle(act: 'grid' | 'onion', on: boolean) {
    prefs[act] = on;
    d.querySelector(`[data-act="${act}"]`)?.setAttribute('aria-pressed', String(on));
    if (act === 'grid') gridSvg.toggleAttribute('hidden', !on);
    else onionImg.hidden = !on || !onionUrl;
  }

  function push(op: Op) {
    ops.push(op);
    redoStack = [];
    dirty = true;
    updateHistoryButtons();
  }
  function undo() {
    if (ops.length <= baseOps) return;
    redoStack.push(ops.pop()!);
    dirty = true;
    rebuild();
    updateHistoryButtons();
  }
  function redo() {
    const op = redoStack.pop();
    if (!op) return;
    ops.push(op);
    dirty = true;
    rebuild();
    updateHistoryButtons();
  }
  function updateHistoryButtons() {
    d.querySelector<HTMLButtonElement>('[data-act="undo"]')!.disabled = ops.length <= baseOps;
    d.querySelector<HTMLButtonElement>('[data-act="redo"]')!.disabled = !redoStack.length;
  }

  async function addImage(file: Blob) {
    try {
      const bmp = await createImageBitmap(file);
      const f = fit(bmp.width, bmp.height, W, H);
      const op: ImageOp = { kind: 'image', bmp, ...f };
      push(op);
      paintOp(cg, op);
      show();
    } catch {
      /* not an image the browser can read */
    }
  }

  /* ---------------- pointer input ---------------- */

  function point(e: PointerEvent): [number, number, number] {
    const r = canvas.getBoundingClientRect();
    const pressure = e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5;
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H, pressure];
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || activePointer !== null) return;
    if (e.pointerType === 'pen') penSeen = true;
    else if (e.pointerType === 'touch' && penSeen) return; // resting palm
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    activePointer = e.pointerId;
    const [x, y, p] = point(e);
    const tool = prefs.tool;
    if (tool === 'line' || tool === 'arrow' || tool === 'rect' || tool === 'ellipse') {
      current = { kind: 'shape', tool, color: prefs.color, size: sizeOf(tool), x0: x, y0: y, x1: x, y1: y };
    } else {
      current = { kind: 'stroke', tool, color: prefs.color, size: sizeOf(tool), pts: [x, y, p] };
      if (tool !== 'marker') paintStroke(g, current);
      else show(current);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activePointer || !current) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
    if (current.kind === 'shape') {
      const [x, y] = point(events[events.length - 1] ?? e);
      current.x1 = x;
      current.y1 = y;
      if (e.shiftKey) constrain(current);
      show(current);
      return;
    }
    const from = current.pts.length;
    for (const ev of events.length ? events : [e]) current.pts.push(...point(ev));
    if (current.tool === 'marker') show(current);
    else paintStroke(g, current, from);
  });
  const finish = (e: PointerEvent) => {
    if (e.pointerId !== activePointer) return;
    activePointer = null;
    const op = current;
    current = null;
    if (!op) return;
    if (op.kind === 'shape' && Math.hypot(op.x1 - op.x0, op.y1 - op.y0) < 3) return show();
    push(op);
    paintOp(cg, op);
    show();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  /** Shift: straight lines snap to 45°, rectangles and ellipses become squares and circles. */
  function constrain(op: ShapeOp) {
    const dx = op.x1 - op.x0;
    const dy = op.y1 - op.y0;
    if (op.tool === 'rect' || op.tool === 'ellipse') {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      op.x1 = op.x0 + Math.sign(dx || 1) * s;
      op.y1 = op.y0 + Math.sign(dy || 1) * s;
    } else {
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      op.x1 = op.x0 + Math.cos(a) * len;
      op.y1 = op.y0 + Math.sin(a) * len;
    }
  }

  /* ---------------- UI events ---------------- */

  return new Promise<Blob | null>((resolve) => {
    let closing = false;
    const close = (result: Blob | null) => {
      if (closing) return;
      closing = true;
      savePrefs(prefs);
      window.removeEventListener('resize', updateSizeDot);
      for (const op of ops) if (op.kind === 'image') op.bmp.close();
      if (onionUrl) URL.revokeObjectURL(onionUrl);
      d.close();
      d.remove();
      if (dialog === d) dialog = null;
      resolve(result);
    };
    const cancel = () => {
      if (dirty && !confirm(t('sk.discard'))) return;
      close(null);
    };
    const save = async () => {
      if (!dirty) return close(null);
      close(await canvasBlob(committed));
    };

    d.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (activePointer === null) cancel();
    });
    d.addEventListener('click', (e) => {
      const el = e.target as HTMLElement;
      const tool = el.closest<HTMLElement>('[data-tool]')?.dataset.tool as Tool | undefined;
      if (tool) return setTool(tool);
      const sw = el.closest<HTMLElement>('.sk-swatch');
      if (sw) return setColor(sw.dataset.color!);
      const act = el.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'cancel') cancel();
      else if (act === 'save') void save();
      else if (act === 'undo') undo();
      else if (act === 'redo') redo();
      else if (act === 'image') fileInput.click();
      else if (act === 'grid') setToggle('grid', !prefs.grid);
      else if (act === 'onion') setToggle('onion', !prefs.onion);
      else if (act === 'clear') {
        push({ kind: 'clear' });
        rebuild();
      }
    });
    colorInput.addEventListener('input', () => setColor(colorInput.value));
    sizeInput.addEventListener('input', () => setSize(Number(sizeInput.value)));
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      fileInput.value = '';
      if (f) void addImage(f);
    });
    d.addEventListener('paste', (e) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      const f = item?.getAsFile();
      if (f) {
        e.preventDefault();
        void addImage(f);
      }
    });
    d.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        redo();
      } else if (mod && k === 's') {
        e.preventDefault();
        void save();
      } else if (!mod && !e.altKey && KEYS[k]) {
        e.preventDefault();
        setTool(KEYS[k]);
      } else if (!mod && (e.key === '[' || e.key === ']')) {
        e.preventDefault();
        const n = sizeOf(prefs.tool);
        setSize(e.key === '[' ? n / 1.25 : Math.max(n + 1, n * 1.25));
      }
    });
    window.addEventListener('resize', updateSizeDot);

    // Start: the panel's drawing (if any) is the base of the canvas.
    const start = async () => {
      if (opts.image) {
        try {
          const bmp = await createImageBitmap(opts.image);
          ops.push({ kind: 'image', bmp, ...fit(bmp.width, bmp.height, W, H) });
        } catch {
          /* unreadable: start blank */
        }
      }
      baseOps = ops.length;
      rebuild();
      updateHistoryButtons();
    };
    if (opts.previous) {
      onionUrl = URL.createObjectURL(opts.previous);
      onionImg.src = onionUrl;
    }
    setTool(prefs.tool);
    setColor(prefs.color);
    setToggle('grid', prefs.grid);
    setToggle('onion', prefs.onion);
    d.showModal();
    updateSizeDot();
    void start();
  });
}
