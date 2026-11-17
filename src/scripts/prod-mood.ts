/**
 * Moodboard: boards of reference images, colours and notes (the look of the
 * film, a location, a character…). Images can be picked, dropped or pasted.
 */
import { newId } from './projects';
import { ICON, button, esc, iconButton, tk, type ProdApi, type Section } from './production';
import type { MoodItem, Production } from './types';

export function createMoodboard(api: ProdApi): Section {
  let boardId: string | null = null;

  const current = (p: Production) => p.moodboards.find((b) => b.id === boardId) ?? p.moodboards[0];

  async function addImages(files: File[]) {
    const p = api.prod();
    let board = current(p);
    if (!board) {
      board = { id: newId(), title: tk('pr.moodDefault'), items: [] };
      const fresh = board;
      api.update((q) => q.moodboards.push(fresh), false);
    }
    const id = board.id;
    const imgs: string[] = [];
    for (const f of files.filter((x) => x.type.startsWith('image/'))) {
      const img = await api.storeImage(f, 1600);
      if (img) imgs.push(img);
    }
    if (!imgs.length) return;
    api.update((q) => q.moodboards.find((b) => b.id === id)?.items.push(...imgs.map((img) => ({ id: newId(), kind: 'image' as const, img }))));
  }

  // Paste images while the moodboard is open (not while typing in a field).
  document.addEventListener('paste', (e) => {
    if (!document.querySelector('.pr-panel[data-section="mood"]')) return;
    if ((e.target as HTMLElement).closest?.('input, textarea')) return;
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    void addImages(files);
  });

  function item(it: MoodItem) {
    const url = it.img ? api.cachedUrl(it.img) : undefined;
    const body =
      it.kind === 'image'
        ? `<img data-img="${esc(it.img!)}" alt=""${url ? ` src="${url}"` : ''} />`
        : it.kind === 'color'
          ? `<label class="pr-swatch" style="--sw:${esc(it.color ?? '#888888')}"><input type="color" data-mood-color value="${esc(it.color ?? '#888888')}" aria-label="${esc(tk('pr.colour'))}" /><span>${esc((it.color ?? '').toUpperCase())}</span></label>`
          : '';
    return `<figure class="pr-mood-item" data-kind="${it.kind}" data-item="${esc(it.id)}">
      ${body}
      ${it.kind === 'image' || it.kind === 'color' ? `<input class="pr-mood-cap" data-mood-text value="${esc(it.text ?? '')}" placeholder="${esc(tk('pr.caption'))}" aria-label="${esc(tk('pr.caption'))}" />` : `<textarea class="pr-mood-note" data-mood-text rows="4" placeholder="${esc(tk('pr.notePh'))}" aria-label="${esc(tk('pr.note'))}">${esc(it.text ?? '')}</textarea>`}
      <div class="pr-mood-acts">${iconButton('mood-left', tk('pr.earlier'), ICON.left)}${iconButton('mood-right', tk('pr.later'), ICON.right)}${iconButton('mood-del', tk('pr.delete'), ICON.trash)}</div>
    </figure>`;
  }

  const editItem = (itemId: string, fn: (it: MoodItem) => void, render = false) =>
    api.update((p) => {
      const b = current(p);
      const it = b?.items.find((x) => x.id === itemId);
      if (it) fn(it);
    }, render);

  return {
    render() {
      const p = api.prod();
      const board = current(p);
      if (!board)
        return `<div class="pr-empty-big"><p>${esc(tk('pr.moodEmpty'))}</p>${button('new-board', tk('pr.newBoard'), ICON.plus, 'btn btn-primary')}</div>`;
      boardId = board.id;
      return `
        <div class="pr-toolbar">
          <div class="pr-boards" role="tablist" aria-label="${esc(tk('pr.tab.mood'))}">
            ${p.moodboards.map((b) => `<button type="button" role="tab" class="pr-chip" data-act="pick-board" data-board="${esc(b.id)}" aria-selected="${b.id === board.id}" aria-pressed="${b.id === board.id}">${esc(b.title || tk('pr.untitledBoard'))}</button>`).join('')}
            ${iconButton('new-board', tk('pr.newBoard'), ICON.plus)}
          </div>
        </div>
        <div class="pr-mood-head">
          <input class="pr-board-title" data-board-title value="${esc(board.title)}" placeholder="${esc(tk('pr.untitledBoard'))}" aria-label="${esc(tk('pr.boardName'))}" />
          ${button('add-image', tk('pr.addImages'), ICON.image)}
          ${button('add-color', tk('pr.addColour'), ICON.plus)}
          ${button('add-note', tk('pr.addNote'), ICON.plus)}
          ${iconButton('del-board', tk('pr.deleteBoard'), ICON.trash)}
        </div>
        ${board.items.length ? `<div class="pr-mood">${board.items.map(item).join('')}</div>` : `<p class="pr-empty pr-mood-drop">${esc(tk('pr.moodDrop'))}</p>`}`;
    },
    click(el, act) {
      const itemId = el.closest<HTMLElement>('[data-item]')?.dataset.item;
      if (act === 'new-board') {
        const id = newId();
        const n = api.prod().moodboards.length;
        api.update((p) => p.moodboards.push({ id, title: n ? tk('pr.boardN', { n: n + 1 }) : tk('pr.moodDefault'), items: [] }));
        boardId = id;
        api.rerender();
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-board-title]')?.select());
      } else if (act === 'pick-board') {
        boardId = el.dataset.board!;
        api.rerender();
      } else if (act === 'del-board') {
        const b = current(api.prod());
        if (!b || (b.items.length && !confirm(tk('pr.confirmDeleteBoard')))) return;
        api.update((p) => (p.moodboards = p.moodboards.filter((x) => x.id !== b.id)));
        boardId = null;
        api.rerender();
      } else if (act === 'add-image') {
        void api.pickImages(true).then((files) => {
          if (files.length) void addImages(files);
        });
      } else if (act === 'add-color' || act === 'add-note') {
        const it: MoodItem = act === 'add-color' ? { id: newId(), kind: 'color', color: '#6a2ed8' } : { id: newId(), kind: 'note', text: '' };
        api.update((p) => current(p)?.items.push(it));
        requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-item="${it.id}"] ${act === 'add-color' ? 'input[type=color]' : 'textarea'}`)?.focus());
      } else if (itemId && act === 'mood-del') {
        api.update((p) => {
          const b = current(p);
          if (b) b.items = b.items.filter((x) => x.id !== itemId);
        });
      } else if (itemId && (act === 'mood-left' || act === 'mood-right')) {
        api.update((p) => {
          const b = current(p);
          if (!b) return;
          const k = b.items.findIndex((x) => x.id === itemId);
          const j = k + (act === 'mood-left' ? -1 : 1);
          if (k < 0 || j < 0 || j >= b.items.length) return;
          [b.items[k], b.items[j]] = [b.items[j], b.items[k]];
        });
      }
    },
    input(el) {
      if (el.matches('[data-board-title]')) {
        const v = (el as HTMLInputElement).value;
        api.update((p) => {
          const b = current(p);
          if (b) b.title = v;
        }, false);
        return;
      }
      const itemId = el.closest<HTMLElement>('[data-item]')?.dataset.item;
      if (!itemId) return;
      if (el.matches('[data-mood-text]')) editItem(itemId, (it) => (it.text = (el as HTMLInputElement).value));
      else if (el.matches('[data-mood-color]')) {
        const v = (el as HTMLInputElement).value;
        const sw = el.closest<HTMLElement>('.pr-swatch');
        sw?.style.setProperty('--sw', v);
        const label = sw?.querySelector('span');
        if (label) label.textContent = v.toUpperCase();
        editItem(itemId, (it) => (it.color = v));
      }
    },
    change(el) {
      if (el.matches('[data-board-title]')) api.rerender();
    },
    dragover(e) {
      return [...(e.dataTransfer?.types ?? [])].includes('Files');
    },
    drop(e) {
      const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
      if (!files.length) return false;
      void addImages(files);
      return true;
    },
  };
}
