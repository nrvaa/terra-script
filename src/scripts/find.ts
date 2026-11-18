/**
 * Find & replace in the script (Ctrl+F / Ctrl+H).
 * Matches are painted with the CSS Custom Highlight API, so nothing is
 * inserted into the editable text; they are re-found whenever the script
 * changes (typing, undo, page layout) while the bar is open.
 */
import type { ScreenplayEditor } from './editor';
import { t } from './i18n';
import { matchCase as followCase } from './rename';
import { paintHighlight, textIndex } from './tagger';

export interface FindCtx {
  editor: ScreenplayEditor;
  editorEl: HTMLElement;
  /** Scrolling container of the script pages. */
  scroller: HTMLElement;
  /** Switch to the script view if another view is showing. */
  showScript(): void;
  toast(msg: string): void;
}

interface Match {
  b: number;
  s: number;
  e: number;
  /** The matched text as it appears in the script. */
  found: string;
  range: Range | null;
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const before = (a: { b: number; s: number }, b: { b: number; s: number }) => a.b < b.b || (a.b === b.b && a.s < b.s);

export function initFind(ctx: FindCtx) {
  const { editor, editorEl, scroller } = ctx;
  const bar = document.querySelector<HTMLElement>('#find-bar')!;
  const input = bar.querySelector<HTMLInputElement>('#find-input')!;
  const repInput = bar.querySelector<HTMLInputElement>('#find-replace')!;
  const count = bar.querySelector<HTMLElement>('#find-count')!;
  const repRow = bar.querySelector<HTMLElement>('[data-find-row="replace"]')!;
  const btn = (name: string) => bar.querySelector<HTMLButtonElement>(`[data-find="${name}"]`)!;

  let matchCase = false;
  let wholeWord = false;
  /** Replacement follows the capitalisation of each match (MAYA → RANI, Maya → Rani). */
  let keepCase = true;
  const replacementFor = (m: Match) => (keepCase ? followCase(m.found, repInput.value) : repInput.value);
  let matches: Match[] = [];
  let cur = -1;
  /** The current match is the first one at or after this position. */
  let anchor = { b: 0, s: 0 };
  let savedCaret: ReturnType<ScreenplayEditor['saveCaret']> = null;
  let frame = 0;

  const isOpen = () => !bar.hidden;

  function regex(): RegExp | null {
    const q = input.value;
    if (!q) return null;
    const body = escRe(q);
    const src = wholeWord ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])` : body;
    return new RegExp(src, matchCase ? 'gu' : 'giu');
  }

  /** Find every match and paint it; keeps the current match near `anchor`. */
  function refresh(scroll = false) {
    cancelAnimationFrame(frame);
    matches = [];
    const re = regex();
    if (re) {
      (Array.from(editorEl.children) as HTMLElement[]).forEach((el, b) => {
        const idx = textIndex(el);
        const text = idx.text.replace(/ /g, ' ');
        for (const m of text.matchAll(re)) {
          const s = m.index!;
          const e = s + m[0].length;
          let range: Range | null = null;
          const a = idx.at(s);
          const z = idx.at(e);
          if (a && z) {
            range = document.createRange();
            try {
              range.setStart(a[0], a[1]);
              range.setEnd(z[0], z[1]);
            } catch {
              range = null;
            }
          }
          matches.push({ b, s, e, found: m[0], range });
        }
      });
    }
    cur = matches.length ? Math.max(0, matches.findIndex((m) => !before(m, anchor))) : -1;
    paint(scroll);
  }

  const scheduleRefresh = () => {
    if (!isOpen()) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => refresh());
  };

  function paint(scroll: boolean) {
    const others = matches.filter((m, i) => i !== cur && m.range).map((m) => m.range!);
    const current = matches[cur]?.range;
    paintHighlight('find-match', others);
    paintHighlight('find-current', current ? [current] : []);
    input.classList.toggle('find-miss', !!input.value && !matches.length);
    count.textContent = !input.value ? '' : matches.length ? t('find.count', { i: cur + 1, n: matches.length }) : t('find.none');
    const none = !matches.length;
    for (const n of ['prev', 'next', 'replace', 'replace-all']) btn(n).disabled = none;
    if (scroll && current) scrollTo(current);
  }

  function scrollTo(range: Range) {
    const r = range.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const box = scroller.getBoundingClientRect();
    const top = box.top + bar.offsetHeight + 24;
    const bottom = box.bottom - 24;
    if (r.top < top || r.bottom > bottom) {
      scroller.scrollBy({ top: r.top - (box.top + box.height / 2), behavior: 'smooth' });
    }
    const left = box.left + 16;
    const right = box.right - 16;
    if (r.left < left || r.right > right) scroller.scrollBy({ left: r.left - (box.left + box.width / 2) });
  }

  function step(dir: 1 | -1) {
    if (!matches.length) return;
    cur = (cur + dir + matches.length) % matches.length;
    anchor = { b: matches[cur].b, s: matches[cur].s };
    paint(true);
  }

  function replaceOne() {
    const m = matches[cur];
    if (!m) return;
    const text = replacementFor(m);
    // Continue with the match after the replaced text.
    anchor = { b: m.b, s: m.s + text.length };
    editor.replaceRanges([{ b: m.b, s: m.s, e: m.e, text }]);
    refresh(true);
  }

  function replaceAll() {
    if (!matches.length) return;
    const n = matches.length;
    editor.replaceRanges(matches.map((m) => ({ b: m.b, s: m.s, e: m.e, text: replacementFor(m) })));
    refresh();
    ctx.toast(t('find.replaced', { n }));
  }

  function setReplace(on: boolean) {
    repRow.hidden = !on;
    btn('toggle').setAttribute('aria-expanded', String(on));
    bar.classList.toggle('find-with-replace', on);
  }

  function open(withReplace = false) {
    ctx.showScript();
    const wasOpen = isOpen();
    if (!wasOpen) savedCaret = editor.saveCaret();
    // Start with the selected text (one line, not too long).
    const sel = window.getSelection();
    const picked = sel && sel.rangeCount && editorEl.contains(sel.anchorNode) ? sel.toString() : '';
    if (picked && !/\n/.test(picked) && picked.length <= 200) input.value = picked;
    const c = editor.saveCaret();
    if (c) anchor = { b: c.b, s: c.o };
    bar.hidden = false;
    if (withReplace) setReplace(true);
    else if (!wasOpen) setReplace(false);
    refresh(true);
    const field = withReplace && input.value ? repInput : input;
    field.focus();
    field.select();
  }

  function close(select = true) {
    if (!isOpen()) return;
    const m = matches[cur];
    bar.hidden = true;
    cancelAnimationFrame(frame);
    paintHighlight('find-match', []);
    paintHighlight('find-current', []);
    if (!select) return;
    // Leave the current match selected in the script, like a browser does.
    editor.focus();
    if (m) editor.restoreCaret({ b: m.b, o: m.s, end: { b: m.b, o: m.e } });
    else editor.restoreCaret(savedCaret);
  }

  function toggleOpt(name: 'case' | 'word' | 'keep') {
    if (name === 'keep') {
      keepCase = !keepCase;
      btn('keep').setAttribute('aria-pressed', String(keepCase));
      return;
    }
    if (name === 'case') matchCase = !matchCase;
    else wholeWord = !wholeWord;
    btn('case').setAttribute('aria-pressed', String(matchCase));
    btn('word').setAttribute('aria-pressed', String(wholeWord));
    refresh(true);
  }

  // Keep focus in the text fields when clicking the bar's buttons.
  bar.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button')) e.preventDefault();
  });
  bar.addEventListener('click', (e) => {
    const name = (e.target as HTMLElement).closest<HTMLElement>('[data-find]')?.dataset.find;
    if (name === 'prev') step(-1);
    else if (name === 'next') step(1);
    else if (name === 'close') close();
    else if (name === 'case' || name === 'word' || name === 'keep') toggleOpt(name);
    else if (name === 'toggle') {
      setReplace(!!repRow.hidden);
      (repRow.hidden ? input : repInput).focus();
    } else if (name === 'replace') replaceOne();
    else if (name === 'replace-all') replaceAll();
  });

  input.addEventListener('input', () => {
    const c = matches[cur];
    // While typing, stay on (or after) the match the user was looking at.
    if (c) anchor = { b: c.b, s: c.s };
    refresh(true);
  });

  bar.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.altKey && !mod && (e.code === 'KeyC' || e.code === 'KeyW' || e.code === 'KeyP')) {
      e.preventDefault();
      e.stopPropagation();
      toggleOpt(e.code === 'KeyC' ? 'case' : e.code === 'KeyW' ? 'word' : 'keep');
    } else if (e.key === 'Enter' && e.target === input) {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Enter' && e.target === repInput) {
      e.preventDefault();
      if (mod) replaceAll();
      else replaceOne();
    }
  });

  // Re-find after any change to the script (typing, undo, page breaks…).
  new MutationObserver(scheduleRefresh).observe(editorEl, { childList: true, subtree: true, characterData: true });

  return {
    open,
    close,
    isOpen,
    next: () => (isOpen() ? step(1) : open()),
    prev: () => (isOpen() ? step(-1) : open()),
  };
}
