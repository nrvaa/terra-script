/**
 * Take log panel: per scene, a list of takes with slate, take number,
 * camera, roll, note and a Good / Maybe / Skip rating.
 * Data lives on the scene block (`takes`), so it moves with the scene,
 * is undoable, saved with the project and included in .terra files.
 */
import type { ScreenplayEditor } from './editor';
import { getLang, t, type Key } from './i18n';
import { newId } from './projects';
import { TAKE_STATUSES, sceneTakeStatus, type Take, type TakeStatus } from './types';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const ICON_X =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';
const ICON_PLUS =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

export interface TakesPanel {
  open(sceneIndex: number): void;
  close(): void;
  toggle(sceneIndex: number | null): void;
  isOpen(): boolean;
  /** Follow the cursor to another scene (script view). */
  follow(sceneIndex: number | null): void;
  /** Re-render after outside changes (undo, reorder) unless the user is typing in it. */
  refresh(): void;
}

export function createTakesPanel(
  root: HTMLElement,
  editor: ScreenplayEditor,
  opts: { onToggle?: (open: boolean) => void },
): TakesPanel {
  let scene: number | null = null;

  const sceneBlock = () => (scene === null ? undefined : editor.getBlocks()[scene]);
  const takesOf = (): Take[] => structuredClone(sceneBlock()?.takes ?? []);
  const save = (takes: Take[], typing = false) => {
    if (scene !== null) editor.updateBlock(scene, { takes }, typing);
  };

  function sceneNumber(index: number): number {
    const blocks = editor.getBlocks();
    let n = 0;
    for (let i = 0; i <= index && i < blocks.length; i++) if (blocks[i].type === 'scene') n++;
    return n;
  }

  function timeLabel(at: number) {
    if (!at) return '';
    return new Date(at).toLocaleTimeString(getLang() === 'id' ? 'id-ID' : 'en-US', { hour: '2-digit', minute: '2-digit' });
  }

  function statusButtons(tk: Take) {
    return TAKE_STATUSES.map(
      (s) =>
        `<button type="button" class="tk-status" data-status="${s}" data-set-status="${s}" aria-pressed="${tk.status === s}" title="${esc(t(`take.${s}` as Key))} (Alt+${t(`take.${s}Key` as Key)})">${esc(t(`take.${s}` as Key))}</button>`,
    ).join('');
  }

  function row(tk: Take, i: number) {
    const field = (name: keyof Take, label: string, cls = '') =>
      `<label class="tk-field ${cls}"><span>${esc(label)}</span><input data-field="${name}" value="${esc(String(tk[name] ?? ''))}" autocomplete="off" spellcheck="false" /></label>`;
    return `<li class="tk-row" data-id="${esc(tk.id)}" data-status="${tk.status}">
      <div class="tk-row-top">
        <span class="tk-index">#${i + 1}</span>
        <div class="tk-statuses" role="group" aria-label="${esc(t('take.rating'))}">${statusButtons(tk)}</div>
        <button type="button" class="tk-icon" data-remove title="${esc(t('take.delete'))}" aria-label="${esc(t('take.delete'))}">${ICON_TRASH}</button>
      </div>
      <div class="tk-grid">
        ${field('slate', t('take.slate'))}
        ${field('take', t('take.take'))}
        ${field('camera', t('take.camera'))}
        ${field('roll', t('take.roll'))}
      </div>
      <label class="tk-field tk-note"><span>${esc(t('take.note'))}</span><input data-field="note" value="${esc(tk.note)}" placeholder="${esc(t('take.notePh'))}" autocomplete="off" /></label>
      ${tk.at ? `<span class="tk-time">${esc(t('take.loggedAt', { time: timeLabel(tk.at) }))}</span>` : ''}
    </li>`;
  }

  function render() {
    const b = sceneBlock();
    if (!b || b.type !== 'scene') {
      root.innerHTML = `<div class="tk-head"><h2>${esc(t('take.title'))}</h2>
        <button type="button" class="tk-icon" data-close aria-label="${esc(t('btn.close'))}">${ICON_X}</button></div>
        <p class="tk-empty">${esc(t('take.noScene'))}</p>`;
      return;
    }
    const takes = b.takes ?? [];
    const count = (s: TakeStatus) => takes.filter((x) => x.status === s).length;
    const overall = sceneTakeStatus(takes);
    root.innerHTML = `
      <div class="tk-head">
        <div class="min-w-0">
          <h2>${esc(t('take.title'))}</h2>
          <p class="tk-scene"><span class="tk-scene-no">${sceneNumber(scene!)}</span>${esc(b.text.toUpperCase() || t('nav.untitledScene'))}</p>
        </div>
        <button type="button" class="tk-icon" data-close aria-label="${esc(t('btn.close'))}" title="${esc(t('btn.close'))} (Alt+T)">${ICON_X}</button>
      </div>
      <div class="tk-summary">
        <span class="tk-chip" ${overall ? `data-status="${overall}"` : ''}>${esc(takes.length === 1 ? t('take.count1') : t('take.count', { n: takes.length }))}</span>
        ${TAKE_STATUSES.map((s) => `<span class="tk-chip" data-status="${s}"><i></i>${count(s)} ${esc(t(`take.${s}` as Key))}</span>`).join('')}
      </div>
      <ol class="tk-list">${takes.length ? takes.map(row).join('') : `<li class="tk-empty">${esc(t('take.none'))}</li>`}</ol>
      <div class="tk-foot">
        <button type="button" class="btn btn-primary btn-icon w-full justify-center" data-add>${ICON_PLUS}<span>${esc(t('take.add'))}</span></button>
        <p class="tk-hint">${esc(t('take.hint'))}</p>
      </div>`;
  }

  function addTake() {
    if (scene === null) return;
    const takes = takesOf();
    const last = takes[takes.length - 1];
    const lastNo = Number.parseInt(last?.take ?? '', 10);
    takes.push({
      id: newId(),
      slate: last?.slate || String(sceneNumber(scene)),
      take: String(Number.isFinite(lastNo) ? lastNo + 1 : takes.length + 1),
      camera: last?.camera || 'A',
      roll: last?.roll || '',
      status: '',
      note: '',
      at: Date.now(),
    });
    save(takes);
    render();
    const rows = root.querySelectorAll<HTMLElement>('.tk-row');
    const added = rows[rows.length - 1];
    added?.scrollIntoView({ block: 'nearest' });
    added?.querySelector<HTMLInputElement>('[data-field=note]')?.focus();
  }

  function setStatus(id: string, status: TakeStatus) {
    const takes = takesOf();
    const tk = takes.find((x) => x.id === id);
    if (!tk) return;
    tk.status = tk.status === status ? '' : status; // click again to clear
    save(takes);
    const focused = document.activeElement as HTMLElement | null;
    const keepField = focused?.dataset.field;
    render();
    const rowEl = root.querySelector<HTMLElement>(`.tk-row[data-id="${CSS.escape(id)}"]`);
    (keepField ? rowEl?.querySelector<HTMLElement>(`[data-field="${keepField}"]`) : rowEl?.querySelector<HTMLElement>(`[data-set-status="${status}"]`))?.focus();
  }

  root.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    const id = input.closest<HTMLElement>('.tk-row')?.dataset.id;
    const field = input.dataset.field as keyof Take | undefined;
    if (!id || !field) return;
    const takes = takesOf();
    const tk = takes.find((x) => x.id === id);
    if (!tk) return;
    (tk as unknown as Record<string, string>)[field] = input.value;
    save(takes, true);
  });
  root.addEventListener('focusout', () => editor.flush());

  root.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (el.closest('[data-close]')) return close();
    if (el.closest('[data-add]')) return addTake();
    const id = el.closest<HTMLElement>('.tk-row')?.dataset.id;
    if (!id) return;
    const statusBtn = el.closest<HTMLElement>('[data-set-status]');
    if (statusBtn) return setStatus(id, statusBtn.dataset.setStatus as TakeStatus);
    if (el.closest('[data-remove]') && confirm(t('take.confirmDelete'))) {
      save(takesOf().filter((x) => x.id !== id));
      render();
    }
  });

  root.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      addTake();
      return;
    }
    // Alt+G / Alt+M / Alt+S rate the take you're typing in.
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const id = (e.target as HTMLElement).closest<HTMLElement>('.tk-row')?.dataset.id;
      const map: Record<string, TakeStatus> = {};
      for (const s of TAKE_STATUSES) map[t(`take.${s}Key` as Key).toLowerCase()] = s;
      const status = map[e.key.toLowerCase()];
      if (id && status) {
        e.preventDefault();
        setStatus(id, status);
      }
    }
    if (e.key === 'Escape') close();
  });

  function open(index: number) {
    scene = index;
    root.hidden = false;
    render();
    opts.onToggle?.(true);
  }
  function close() {
    root.hidden = true;
    scene = null;
    editor.flush();
    opts.onToggle?.(false);
  }
  const typingInside = () => {
    const a = document.activeElement;
    return Boolean(a && root.contains(a) && a.tagName === 'INPUT');
  };

  return {
    open,
    close,
    isOpen: () => !root.hidden,
    toggle(index) {
      if (!root.hidden) close();
      else if (index !== null) open(index);
      else open(-1);
    },
    follow(index) {
      if (root.hidden || typingInside() || index === scene) return;
      scene = index ?? -1;
      render();
    },
    refresh() {
      if (root.hidden || typingInside()) return;
      const b = sceneBlock();
      if (!b || b.type !== 'scene') scene = -1;
      render();
    },
  };
}
