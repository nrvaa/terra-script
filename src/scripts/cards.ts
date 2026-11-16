/**
 * Index-card view: one card per scene (heading, synopsis, colour, speakers).
 * Cards can be dragged (or moved with buttons) to reorder whole scenes;
 * every change goes through the editor, so it is saved and undoable.
 */
import type { ScreenplayEditor } from './editor';
import { t, type Key } from './i18n';
import { CARD_COLORS, characterName, sceneTakeStatus, type Block, type CardColor } from './types';

interface Unit {
  kind: 'pre' | 'scene' | 'divider';
  start: number; // block index (inclusive)
  end: number; // block index (exclusive)
}

const BOUNDARY = new Set(['scene', 'section', 'act', 'endact']);

/** Split the script into movable chunks: [opening] + scenes + act/sequence dividers. */
function toUnits(blocks: Block[]): Unit[] {
  const out: Unit[] = [];
  let cur: Unit = { kind: 'pre', start: 0, end: 0 };
  blocks.forEach((b, i) => {
    if (!BOUNDARY.has(b.type)) return;
    cur.end = i;
    if (cur.end > cur.start) out.push(cur);
    cur = { kind: b.type === 'scene' ? 'scene' : 'divider', start: i, end: i };
  });
  cur.end = blocks.length;
  if (cur.end > cur.start) out.push(cur);
  return out;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const ICON_OPEN =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>';
const ICON_LEFT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
const ICON_RIGHT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
const ICON_GRIP =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';

export interface CardsBoard {
  render(): void;
  /** True while the user is typing inside a card (don't re-render under them). */
  isEditing(): boolean;
  focusScene(blockIndex: number): void;
}

export function createCardsBoard(
  root: HTMLElement,
  editor: ScreenplayEditor,
  opts: { onOpenScene: (blockIndex: number) => void; onTakes: (blockIndex: number) => void; sceneNumbers: () => boolean },
): CardsBoard {
  let units: Unit[] = [];
  let dragFrom: number | null = null;

  const palette = document.createElement('div');
  palette.className = 'color-pop';
  palette.hidden = true;
  palette.setAttribute('role', 'menu');
  document.body.appendChild(palette);
  let paletteFor: number | null = null;

  function takeBadge(b: Block): string {
    const n = b.takes?.length ?? 0;
    const status = sceneTakeStatus(b.takes);
    const label = n ? (n === 1 ? t('take.count1') : t('take.count', { n })) : t('take.add');
    return `<button type="button" class="take-badge" data-act="takes"${status ? ` data-status="${status}"` : ''} title="${esc(t('take.title'))}"><i class="take-dot"${status ? ` data-status="${status}"` : ''}></i>${esc(label)}</button>`;
  }

  function render() {
    const blocks = editor.getBlocks();
    units = toUnits(blocks);
    const parts: string[] = [];
    let sceneNo = 0;
    let scenes = 0;

    units.forEach((u, ui) => {
      if (u.kind === 'pre') return;
      const b = blocks[u.start];
      if (u.kind === 'divider') {
        const label = b.text.trim() || t(b.type === 'section' ? 'nav.sequence' : 'nav.act');
        parts.push(`<div class="board-divider" draggable="true" data-unit="${ui}" data-type="${b.type}">
          <span class="grip" aria-hidden="true">${ICON_GRIP}</span><span class="board-divider-label">${esc(label)}</span></div>`);
        return;
      }
      sceneNo++;
      scenes++;
      const speakers = [...new Set(blocks.slice(u.start, u.end).filter((x) => x.type === 'character').map((x) => characterName(x.text)).filter(Boolean))];
      const shown = speakers.slice(0, 3).join(', ');
      const more = speakers.length > 3 ? ` +${speakers.length - 3}` : '';
      parts.push(`<article class="scard" draggable="true" data-unit="${ui}" data-block="${u.start}"${b.color ? ` data-color="${esc(b.color)}"` : ''}>
        <div class="scard-top">
          <span class="grip" aria-hidden="true">${ICON_GRIP}</span>
          ${opts.sceneNumbers() ? `<span class="scard-num">${sceneNo}</span>` : ''}
          <button type="button" class="scard-dot" data-act="color" title="${esc(t('cards.color'))}" aria-label="${esc(t('cards.color'))}"></button>
          <button type="button" class="scard-btn ml-auto" data-act="open" title="${esc(t('cards.open'))}" aria-label="${esc(t('cards.open'))}">${ICON_OPEN}</button>
        </div>
        <input class="scard-heading" data-field="text" value="${esc(b.text)}" placeholder="${esc(t('ph.scene'))}" aria-label="${esc(t('cards.headingLabel', { n: sceneNo }))}" spellcheck="false" />
        <textarea class="scard-syn" data-field="synopsis" rows="4" placeholder="${esc(t('cards.synopsis'))}" aria-label="${esc(t('cards.synopsisLabel', { n: sceneNo }))}">${esc(b.synopsis ?? '')}</textarea>
        <div class="scard-foot">
          ${takeBadge(b)}
          <span class="scard-chars" title="${esc(speakers.join(', '))}">${speakers.length ? esc(shown + more) : esc(t('cards.noChars'))}</span>
          <span class="scard-move">
            <button type="button" class="scard-btn" data-act="earlier" title="${esc(t('cards.earlier'))}" aria-label="${esc(t('cards.earlier'))}">${ICON_LEFT}</button>
            <button type="button" class="scard-btn" data-act="later" title="${esc(t('cards.later'))}" aria-label="${esc(t('cards.later'))}">${ICON_RIGHT}</button>
          </span>
        </div>
      </article>`);
    });

    root.innerHTML = `
      <div class="board-head">
        <p class="text-muted text-sm">${esc(scenes ? t('cards.hint') : t('cards.empty'))}</p>
        <span class="text-muted text-sm ml-auto whitespace-nowrap">${esc(scenes === 1 ? t('proj.scene1') : t('proj.scenes', { n: scenes }))}</span>
      </div>
      <div class="board-grid">
        ${parts.join('')}
        <button type="button" class="scard-add" data-act="add">
          <span class="proj-new-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span>
          <span>${esc(t('cards.add'))}</span>
        </button>
      </div>`;
  }

  /* ---------------- reordering ---------------- */

  function move(from: number, to: number, before: boolean): number | null {
    if (from === to || units[from]?.kind === 'pre' || !units[to]) return null;
    // Nothing may go above the opening (e.g. FADE IN:).
    if (units[to].kind === 'pre') before = false;
    const blocks = editor.getBlocks();
    const chunks = units.map((u) => blocks.slice(u.start, u.end));
    const [moving] = chunks.splice(from, 1);
    let target = to > from ? to - 1 : to;
    if (!before) target++;
    chunks.splice(target, 0, moving);
    editor.replaceBlocks(chunks.flat());
    render();
    return target;
  }

  function focusUnit(ui: number, selector: string) {
    root.querySelector<HTMLElement>(`[data-unit="${ui}"] ${selector}`)?.focus();
  }

  function addScene() {
    const blocks = editor.getBlocks();
    const onlyEmpty = blocks.length === 1 && !blocks[0].text.trim();
    const next: Block[] = onlyEmpty ? [{ type: 'scene', text: '' }, { type: 'action', text: '' }] : [...blocks, { type: 'scene', text: '' }, { type: 'action', text: '' }];
    editor.replaceBlocks(next);
    render();
    const cards = root.querySelectorAll<HTMLElement>('.scard');
    const last = cards[cards.length - 1];
    last?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    last?.querySelector<HTMLInputElement>('.scard-heading')?.focus();
  }

  /* ---------------- events ---------------- */

  root.addEventListener('input', (e) => {
    const field = e.target as HTMLInputElement | HTMLTextAreaElement;
    const card = field.closest<HTMLElement>('.scard');
    if (!card) return;
    const index = Number(card.dataset.block);
    if (field.dataset.field === 'text') editor.updateBlock(index, { text: field.value }, true);
    else if (field.dataset.field === 'synopsis') editor.updateBlock(index, { synopsis: field.value.trim() ? field.value : '' }, true);
  });
  root.addEventListener('focusout', () => editor.flush());
  root.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement;
    if (el.classList.contains('scard-heading') && e.key === 'Enter') {
      e.preventDefault();
      el.closest('.scard')?.querySelector<HTMLTextAreaElement>('.scard-syn')?.focus();
    }
  });

  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'add') return addScene();
    const card = btn.closest<HTMLElement>('[data-unit]');
    if (!card) return;
    const ui = Number(card.dataset.unit);
    if (act === 'open') opts.onOpenScene(Number(card.dataset.block));
    else if (act === 'takes') opts.onTakes(Number(card.dataset.block));
    else if (act === 'earlier' || act === 'later') {
      const to = ui + (act === 'earlier' ? -1 : 1);
      if (!units[to] || units[to].kind === 'pre') return;
      const target = move(ui, to, act === 'earlier');
      if (target !== null) focusUnit(target, `[data-act="${act}"]`);
    } else if (act === 'color') openPalette(btn, Number(card.dataset.block));
  });

  // Drag & drop. Inputs inside cards must stay selectable, so dragging only
  // starts from the card itself, not from a text field.
  root.addEventListener('mousedown', (e) => {
    const field = (e.target as HTMLElement).closest('input, textarea');
    const card = (e.target as HTMLElement).closest<HTMLElement>('[draggable]');
    if (card) card.draggable = !field;
  });
  root.addEventListener('dragstart', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('[data-unit]');
    if (!card) return;
    dragFrom = Number(card.dataset.unit);
    card.classList.add('dragging');
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', String(dragFrom));
  });
  const clearMarks = () =>
    root.querySelectorAll('.drop-before, .drop-after, .dragging').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'dragging'));
  const dropInfo = (e: DragEvent) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-unit]');
    if (!target || dragFrom === null) return null;
    const r = target.getBoundingClientRect();
    const isDivider = target.classList.contains('board-divider');
    const before = isDivider ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2;
    return { target, to: Number(target.dataset.unit), before };
  };
  root.addEventListener('dragover', (e) => {
    const info = dropInfo(e);
    if (!info) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    root.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    if (info.to !== dragFrom) info.target.classList.add(info.before ? 'drop-before' : 'drop-after');
  });
  root.addEventListener('drop', (e) => {
    const info = dropInfo(e);
    e.preventDefault();
    const from = dragFrom;
    clearMarks();
    dragFrom = null;
    if (info && from !== null) move(from, info.to, info.before);
  });
  root.addEventListener('dragend', () => {
    clearMarks();
    dragFrom = null;
  });

  /* ---------------- colour palette ---------------- */

  function openPalette(btn: HTMLElement, blockIndex: number) {
    paletteFor = blockIndex;
    palette.innerHTML =
      `<button type="button" class="swatch swatch-none" data-color="" title="${esc(t('cards.colorNone'))}" aria-label="${esc(t('cards.colorNone'))}"></button>` +
      CARD_COLORS.map((c) => `<button type="button" class="swatch" data-color="${c}" title="${esc(t(`color.${c}` as Key))}" aria-label="${esc(t(`color.${c}` as Key))}"></button>`).join('');
    palette.hidden = false;
    const r = btn.getBoundingClientRect();
    palette.style.left = `${Math.min(r.left, window.innerWidth - palette.offsetWidth - 8)}px`;
    palette.style.top = `${r.bottom + 6}px`;
    palette.querySelector<HTMLElement>('.swatch')?.focus();
  }
  const closePalette = () => {
    palette.hidden = true;
    paletteFor = null;
  };
  palette.addEventListener('click', (e) => {
    const sw = (e.target as HTMLElement).closest<HTMLElement>('[data-color]');
    if (!sw || paletteFor === null) return;
    const color = (sw.dataset.color || undefined) as CardColor | undefined;
    editor.updateBlock(paletteFor, { color });
    const card = root.querySelector<HTMLElement>(`.scard[data-block="${paletteFor}"]`);
    if (card) {
      if (color) card.dataset.color = color;
      else delete card.dataset.color;
      card.querySelector<HTMLElement>('.scard-dot')?.focus();
    }
    closePalette();
  });
  document.addEventListener('mousedown', (e) => {
    if (!palette.hidden && !palette.contains(e.target as Node)) closePalette();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !palette.hidden) closePalette();
  });

  return {
    render,
    isEditing: () => {
      const a = document.activeElement;
      return Boolean(a && root.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'));
    },
    focusScene(blockIndex: number) {
      const card = root.querySelector<HTMLElement>(`.scard[data-block="${blockIndex}"]`);
      if (!card) return;
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 900);
      card.querySelector<HTMLElement>('.scard-heading')?.focus({ preventScroll: true });
    },
  };
}
