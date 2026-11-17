import { parseFountain, toFountain } from './fountain';
import { t, type Key } from './i18n';
import { parseTerra } from './projects';
import { concatRuns, hasFlag, readRich, renderRich, shiftRuns, sliceRuns, toggleRange, type Flag } from './rich';
import {
  EMPTY_ENTER,
  NEXT_ON_ENTER,
  SCENE_PREFIX,
  SHIFT_TAB_NEXT,
  TAB_NEXT,
  characterName,
  type Block,
  type CardColor,
  type ElType,
  type Panel,
  type Run,
  type Take,
} from './types';

/** Short random id for a scene (same alphabet as projects.newId). */
const newSceneId = () => Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 8);

/** Block properties stored as data attributes on the element. */
type Props = Partial<Pick<Block, 'text' | 'synopsis' | 'color' | 'takes' | 'board' | 'mark' | 'omit' | 'num' | 'newPage' | 'pg' | 'pgLine' | 'fmt'>>;

interface Caret {
  b: number;
  o: number;
}
interface Sel {
  start: Caret;
  end: Caret;
  collapsed: boolean;
}
interface HistoryState {
  blocks: Block[];
  caret: Caret;
}
interface Suggestion {
  label: string;
  apply: string;
  hint?: string;
}
interface SuggestionList {
  title: string;
  items: Suggestion[];
  /** Highlight the first item (so Enter picks it). */
  preselect: boolean;
}

const CLIP_MIME = 'web application/x-terra+json';

const SCENE_PREFIXES: { code: string; hint: Key }[] = [
  { code: 'INT. ', hint: 'ac.int' },
  { code: 'EXT. ', hint: 'ac.ext' },
  { code: 'INT./EXT. ', hint: 'ac.intext' },
  { code: 'I/E. ', hint: 'ac.ie' },
  { code: 'EST. ', hint: 'ac.est' },
];
const EXTENSIONS: { code: string; hint: Key }[] = [
  { code: 'V.O.', hint: 'ac.vo' },
  { code: 'O.S.', hint: 'ac.os' },
  { code: 'O.C.', hint: 'ac.oc' },
  { code: "CONT'D", hint: 'ac.contd' },
];
const TIMES_EN = ['DAY', 'NIGHT', 'MORNING', 'EVENING', 'CONTINUOUS', 'LATER', 'MOMENTS LATER'];
const TIMES_ID = ['SIANG', 'MALAM', 'PAGI', 'SORE'];
let TIMES = [...TIMES_EN, ...TIMES_ID];

/** Put the scene times of the UI language first in suggestions. */
export function setSuggestionLang(lang: 'en' | 'id') {
  TIMES = lang === 'id' ? [...TIMES_ID, ...TIMES_EN] : [...TIMES_EN, ...TIMES_ID];
}
const TRANSITIONS = ['CUT TO:', 'FADE IN:', 'FADE OUT.', 'FADE TO BLACK.', 'DISSOLVE TO:', 'SMASH CUT TO:', 'MATCH CUT TO:', 'JUMP CUT TO:', 'INTERCUT WITH:'];

export interface EditorOptions {
  onChange?: () => void;
  onCaretMove?: (type: ElType, blockIndex: number) => void;
}

export interface EditorPrefs {
  /** Dropdowns for scene headings, characters and transitions. */
  autocomplete: boolean;
  /** INT. → Scene, ( → Parenthetical while typing. */
  smartType: boolean;
  /** Keep the line being typed in the middle of the screen. */
  typewriter: boolean;
}

export class ScreenplayEditor {
  readonly root: HTMLElement;
  private opts: EditorOptions;
  private history: HistoryState[] = [];
  private hIndex = -1;
  private typingTimer: number | undefined;
  private pending = false;
  private composing = false;
  private currentEl: HTMLElement | null = null;

  private ac: HTMLElement;
  private acItems: Suggestion[] = [];
  private acIndex = 0;
  private acTitle = '';
  /** Line on which the user closed the dropdown with Esc (don't reopen it there). */
  private acDismissed: HTMLElement | null = null;
  private acLineType: string | undefined;
  prefs: EditorPrefs = { autocomplete: true, smartType: true, typewriter: false };

  constructor(root: HTMLElement, opts: EditorOptions = {}) {
    this.root = root;
    this.opts = opts;
    root.contentEditable = 'true';
    root.spellcheck = false;

    this.ac = document.createElement('div');
    this.ac.className = 'autocomplete';
    this.ac.hidden = true;
    this.ac.setAttribute('role', 'listbox');
    document.body.appendChild(this.ac);
    this.ac.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const item = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (item) this.acceptSuggestion(Number(item.dataset.i));
    });

    root.addEventListener('keydown', (e) => this.onKeyDown(e));
    root.addEventListener('beforeinput', (e) => this.onBeforeInput(e));
    root.addEventListener('input', () => this.onInput());
    root.addEventListener('paste', (e) => this.onPaste(e));
    root.addEventListener('copy', (e) => this.onCopy(e, false));
    root.addEventListener('cut', (e) => this.onCopy(e, true));
    root.addEventListener('drop', (e) => e.preventDefault());
    root.addEventListener('compositionstart', () => (this.composing = true));
    root.addEventListener('compositionend', () => {
      this.composing = false;
      this.onInput();
    });
    root.addEventListener('blur', () => this.hideAutocomplete());
    document.addEventListener('selectionchange', () => this.onSelectionChange());
    window.addEventListener('resize', () => this.hideAutocomplete());
    // Scrolling (incl. the editor keeping the caret in view) moves the dropdown with the caret.
    root.closest('main')?.addEventListener('scroll', () => this.positionAutocomplete());
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */

  load(blocks: Block[]) {
    const bs = blocks.length ? blocks : [{ type: 'scene' as ElType, text: '' }];
    this.render(bs);
    this.history = [];
    this.hIndex = -1;
    this.pending = false;
    this.pushHistory({ blocks: this.getBlocks(), caret: { b: 0, o: 0 } });
    this.opts.onChange?.();
  }

  getBlocks(): Block[] {
    const sids = new Set<string>();
    return this.els().map((el) => {
      const rich = readRich(el);
      const b: Block = { type: (el.dataset.type as ElType) || 'action', text: rich.text };
      if (rich.fmt) b.fmt = rich.fmt;
      if (el.dataset.dual) b.dual = true;
      if (el.dataset.mark) b.mark = true;
      if (el.dataset.pg) {
        b.pg = el.dataset.pg;
        b.pgLine = Number(el.dataset.pgLine) || 0;
      }
      if (b.type === 'scene') {
        // Every scene keeps one stable id (the schedule refers to it). New scenes,
        // and copies that came with a duplicate id, get a fresh one here, so it is
        // part of every undo step from the moment the scene exists.
        if (!el.dataset.sid || sids.has(el.dataset.sid)) el.dataset.sid = newSceneId();
        sids.add(el.dataset.sid);
        b.sid = el.dataset.sid;
        if (el.dataset.lnum) b.num = el.dataset.lnum;
        if (el.dataset.newPage) b.newPage = true;
        if (el.dataset.omit) {
          try {
            b.omit = JSON.parse(el.dataset.omit) as Block[];
          } catch {
            /* ignore corrupt data */
          }
        }
        if (el.dataset.synopsis) b.synopsis = el.dataset.synopsis;
        if (el.dataset.color) b.color = el.dataset.color as CardColor;
        if (el.dataset.takes) {
          try {
            b.takes = JSON.parse(el.dataset.takes) as Take[];
          } catch {
            /* ignore corrupt data */
          }
        }
        if (el.dataset.board) {
          try {
            b.board = JSON.parse(el.dataset.board) as Panel[];
          } catch {
            /* ignore corrupt data */
          }
        }
      }
      return b;
    });
  }

  focus(blockIndex?: number, offset?: number) {
    this.root.focus({ preventScroll: true });
    if (blockIndex !== undefined) {
      this.setCaret({ b: blockIndex, o: offset ?? this.textOf(this.els()[blockIndex]).length });
      this.scrollToBlock(blockIndex);
    }
  }

  scrollToBlock(i: number) {
    this.els()[i]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  currentType(): ElType {
    return (this.currentEl?.dataset.type as ElType) || 'action';
  }

  currentIndex(): number {
    return this.currentEl ? this.els().indexOf(this.currentEl) : -1;
  }

  /** Change the element type of the block(s) at the cursor. */
  setType(type: ElType) {
    this.flush();
    let sel = this.getSel();
    if (!sel) {
      const last = this.els().length - 1;
      this.root.focus();
      this.setCaret({ b: last, o: this.textOf(this.els()[last]).length });
      sel = this.getSel()!;
    }
    const els = this.els();
    let caret = { ...sel.end };
    for (let i = sel.start.b; i <= sel.end.b; i++) {
      const el = els[i];
      const from = el.dataset.type as ElType;
      if (from === type) continue;
      const rich = readRich(el);
      let text = rich.text;
      let fmt = rich.fmt;
      if (type === 'parenthetical' && !text.trim().startsWith('(')) {
        const lead = text.length - text.trimStart().length;
        const inner = text.trim();
        fmt = shiftRuns(sliceRuns(fmt, lead, lead + inner.length), 1, inner.length + 2);
        text = `(${inner})`;
        if (i === caret.b) caret.o = Math.min(caret.o + 1, text.length - 1);
      } else if (from === 'parenthetical' && type !== 'parenthetical') {
        const m = text.match(/^(\s*\()(.*)\)\s*$/);
        if (m) {
          fmt = sliceRuns(fmt, m[1].length, m[1].length + m[2].length);
          text = m[2];
          if (i === caret.b) caret.o = Math.max(0, Math.min(caret.o - 1, text.length));
        }
      }
      el.dataset.type = type;
      if (type !== 'character') delete el.dataset.dual;
      if (type !== 'scene') {
        for (const k of ['synopsis', 'color', 'takes', 'board', 'omit', 'lnum', 'newPage', 'sid']) delete el.dataset[k];
      }
      this.setText(el, text, fmt);
    }
    this.setCaret(caret);
    this.commit();
    this.onSelectionChange(true);
  }

  /** Toggle dual dialogue on the character that owns the current dialogue. */
  toggleDual() {
    const els = this.els();
    let i = this.currentIndex();
    while (i >= 0 && ['dialogue', 'parenthetical', 'lyrics'].includes(els[i].dataset.type!)) i--;
    if (i < 0 || els[i].dataset.type !== 'character') return false;
    this.flush();
    if (els[i].dataset.dual) delete els[i].dataset.dual;
    else els[i].dataset.dual = '1';
    this.commit();
    return true;
  }

  undo() {
    this.flush();
    if (this.hIndex <= 0) return;
    this.hIndex--;
    this.restore(this.history[this.hIndex]);
  }

  redo() {
    this.flush();
    if (this.hIndex >= this.history.length - 1) return;
    this.hIndex++;
    this.restore(this.history[this.hIndex]);
  }

  /** Cursor position as (block, offset), or null if the editor doesn't have it. */
  saveCaret(): { b: number; o: number; end?: { b: number; o: number } } | null {
    const s = this.getSel();
    return s ? { ...s.start, end: s.collapsed ? undefined : s.end } : null;
  }

  restoreCaret(c: { b: number; o: number; end?: { b: number; o: number } } | null) {
    if (!c) return;
    this.setCaret(c);
    if (c.end) {
      const sel = window.getSelection();
      const startRange = sel?.rangeCount ? sel.getRangeAt(0) : null;
      this.setCaret(c.end);
      const endRange = sel?.rangeCount ? sel.getRangeAt(0) : null;
      if (startRange && endRange) {
        const r = document.createRange();
        r.setStart(startRange.startContainer, startRange.startOffset);
        r.setEnd(endRange.startContainer, endRange.startOffset);
        sel!.removeAllRanges();
        sel!.addRange(r);
      }
    }
  }

  closeSuggestions() {
    this.hideAutocomplete();
  }

  /** Replace the whole script (e.g. after reordering scene cards). Undoable. */
  replaceBlocks(blocks: Block[]) {
    this.flush();
    this.render(blocks.length ? blocks : [{ type: 'scene', text: '' }]);
    this.commit();
  }

  /**
   * Update one block in place (card heading / synopsis / colour).
   * `typing: true` groups rapid edits into one undo step.
   */
  updateBlock(index: number, patch: Props, typing = false) {
    const el = this.els()[index];
    if (!el) return;
    this.applyProps(el, patch);
    if (typing) this.scheduleCommit();
    else this.commit();
  }

  /** Change several blocks as one undo step. */
  updateBlocks(patches: Map<number, Props>) {
    this.flush();
    const els = this.els();
    const caret = this.saveCaret();
    for (const [i, p] of patches) if (els[i]) this.applyProps(els[i], p);
    if (caret) this.restoreCaret(caret);
    this.commit();
  }

  private applyProps(el: HTMLElement, patch: Props) {
    if (patch.text !== undefined) this.setText(el, patch.text.replace(/\n/g, ' '), 'fmt' in patch ? patch.fmt : undefined);
    else if ('fmt' in patch) this.setText(el, this.textOf(el), patch.fmt);
    const set = (key: string, v: string | undefined) => {
      if (v) el.dataset[key] = v;
      else delete el.dataset[key];
    };
    if ('synopsis' in patch) set('synopsis', patch.synopsis);
    if ('color' in patch) set('color', patch.color);
    if ('takes' in patch) set('takes', patch.takes?.length ? JSON.stringify(patch.takes) : undefined);
    if ('board' in patch) set('board', patch.board?.length ? JSON.stringify(patch.board) : undefined);
    if ('mark' in patch) set('mark', patch.mark ? '1' : undefined);
    if ('omit' in patch) set('omit', patch.omit?.length ? JSON.stringify(patch.omit) : undefined);
    if ('num' in patch) set('lnum', patch.num);
    if ('newPage' in patch) set('newPage', patch.newPage ? '1' : undefined);
    if ('pg' in patch) {
      set('pg', patch.pg);
      set('pgLine', patch.pg && patch.pgLine ? String(patch.pgLine) : undefined);
    }
  }

  /** Selection as block/offset range (or the caret when collapsed). */
  selection(): Sel | null {
    return this.getSel();
  }

  /** Is the formatting `flag` on at the cursor / over the whole selection? */
  formatActive(flag: Flag): boolean {
    const sel = this.getSel();
    if (!sel) return false;
    if (sel.collapsed) {
      const r = readRich(this.els()[sel.end.b]);
      return hasFlag(r.text, r.fmt, sel.end.o, sel.end.o, flag);
    }
    return this.formatActiveRange(sel.start, sel.end, flag);
  }

  private formatActiveRange(start: Caret, end: Caret, flag: Flag): boolean {
    const els = this.els();
    let any = false;
    for (let i = start.b; i <= end.b; i++) {
      const r = readRich(els[i]);
      const s = i === start.b ? start.o : 0;
      const e = i === end.b ? end.o : r.text.length;
      if (e <= s) continue;
      any = true;
      if (!hasFlag(r.text, r.fmt, s, e, flag)) return false;
    }
    return any;
  }

  /** Bold / italic / underline / strikethrough on the selection (or the word at the cursor). */
  toggleFormat(flag: Flag) {
    this.flush();
    const sel = this.getSel();
    if (!sel) return;
    const els = this.els();
    let { start, end } = sel;
    if (sel.collapsed) {
      // No selection: format the word under the cursor.
      const text = this.textOf(els[start.b]);
      let s = start.o;
      let e = start.o;
      while (s > 0 && /[\p{L}\p{N}'’]/u.test(text[s - 1])) s--;
      while (e < text.length && /[\p{L}\p{N}'’]/u.test(text[e])) e++;
      if (s === e) return;
      start = { b: start.b, o: s };
      end = { b: start.b, o: e };
    }
    const on = !this.formatActiveRange(start, end, flag);
    for (let i = start.b; i <= end.b; i++) {
      const r = readRich(els[i]);
      const s = i === start.b ? start.o : 0;
      const e = i === end.b ? end.o : r.text.length;
      if (e > s) this.setText(els[i], r.text, toggleRange(r.text, r.fmt, s, e, flag, on));
    }
    this.restoreCaret(sel.collapsed ? sel.start : { ...start, end });
    this.commit();
    this.opts.onCaretMove?.(this.currentType(), this.currentIndex());
  }

  /** Commit pending typing into history now. */
  flush() {
    if (this.pending) this.commit();
  }

  /* ------------------------------------------------------------------ */
  /* DOM helpers                                                         */
  /* ------------------------------------------------------------------ */

  private els(): HTMLElement[] {
    return Array.from(this.root.children) as HTMLElement[];
  }

  private textOf(el: HTMLElement | undefined): string {
    return (el?.textContent ?? '').replace(/ /g, ' ').replace(/\n/g, ' ');
  }

  private makeEl(b: Block): HTMLElement {
    const d = document.createElement('div');
    d.className = 'el';
    d.dataset.type = b.type;
    if (b.dual && b.type === 'character') d.dataset.dual = '1';
    if (b.mark) d.dataset.mark = '1';
    if (b.pg) {
      d.dataset.pg = b.pg;
      if (b.pgLine) d.dataset.pgLine = String(b.pgLine);
    }
    if (b.type === 'scene') {
      if (b.synopsis) d.dataset.synopsis = b.synopsis;
      if (b.color) d.dataset.color = b.color;
      if (b.takes?.length) d.dataset.takes = JSON.stringify(b.takes);
      if (b.board?.length) d.dataset.board = JSON.stringify(b.board);
      if (b.omit?.length) d.dataset.omit = JSON.stringify(b.omit);
      if (b.num) d.dataset.lnum = b.num;
      if (b.newPage) d.dataset.newPage = '1';
      if (b.sid) d.dataset.sid = b.sid;
    }
    this.setText(d, b.text, b.fmt);
    return d;
  }

  private setText(el: HTMLElement, text: string, fmt?: Run[]) {
    renderRich(el, text, fmt);
  }

  private rich(el: HTMLElement) {
    return readRich(el);
  }

  private render(blocks: Block[]) {
    const frag = document.createDocumentFragment();
    for (const b of blocks) frag.appendChild(this.makeEl(b));
    this.root.replaceChildren(frag);
    this.currentEl = null;
  }

  private blockOf(node: Node | null): HTMLElement | null {
    while (node && node.parentNode !== this.root) node = node.parentNode;
    return node && node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : null;
  }

  private offsetIn(block: HTMLElement, node: Node, offset: number): number {
    const r = document.createRange();
    r.selectNodeContents(block);
    try {
      r.setEnd(node, offset);
    } catch {
      return 0;
    }
    return r.toString().replace(/\n/g, '').length;
  }

  private posOf(node: Node, offset: number): Caret | null {
    if (node === this.root) {
      const els = this.els();
      if (!els.length) return null;
      if (offset >= els.length) return { b: els.length - 1, o: this.textOf(els[els.length - 1]).length };
      return { b: offset, o: 0 };
    }
    const block = this.blockOf(node);
    if (!block) return null;
    return { b: this.els().indexOf(block), o: this.offsetIn(block, node, offset) };
  }

  private getSel(): Sel | null {
    const s = window.getSelection();
    if (!s || s.rangeCount === 0) return null;
    const r = s.getRangeAt(0);
    if (!this.root.contains(r.startContainer) || !this.root.contains(r.endContainer)) return null;
    const start = this.posOf(r.startContainer, r.startOffset);
    const end = this.posOf(r.endContainer, r.endOffset);
    if (!start || !end) return null;
    return { start, end, collapsed: r.collapsed };
  }

  private getCaret(): Caret {
    return this.getSel()?.end ?? { b: 0, o: 0 };
  }

  private setCaret(c: Caret) {
    const els = this.els();
    const el = els[Math.max(0, Math.min(c.b, els.length - 1))];
    if (!el) return;
    let remaining = Math.max(0, c.o);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    let last: Text | null = null;
    const r = document.createRange();
    while ((node = walker.nextNode())) {
      const len = (node as Text).length;
      if (remaining <= len) {
        r.setStart(node, remaining);
        r.collapse(true);
        this.applyRange(r);
        return;
      }
      remaining -= len;
      last = node as Text;
    }
    if (last) r.setStart(last, last.length);
    else {
      if (!el.firstChild) el.appendChild(document.createElement('br'));
      r.setStart(el, 0);
    }
    r.collapse(true);
    this.applyRange(r);
  }

  private applyRange(r: Range) {
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  }

  /** Keep the invariant: root contains only div.el children. */
  private normalize() {
    const nodes = Array.from(this.root.childNodes);
    const ok =
      nodes.length > 0 &&
      nodes.every((n) => n instanceof HTMLElement && n.tagName === 'DIV' && n.classList.contains('el') && n.dataset.type);
    if (ok) {
      // Strip any formatting markup a browser may have injected inside a block.
      for (const el of nodes as HTMLElement[]) {
        // Page-break spacers (.pg-break) are layout only and allowed inside blocks.
        // Our own <b>/<i>/<u>/<s> runs are fine; anything else is rebuilt from them.
        if (el.querySelector('*:not(br):not(.pg-break):not(b):not(i):not(u):not(s), [style]:not(.pg-break)')) {
          const c = this.getCaret();
          const r = this.rich(el);
          this.setText(el, r.text, r.fmt);
          this.setCaret(c);
        }
      }
      return;
    }
    const caret = this.getCaret();
    const blocks: Block[] = [];
    let lastType: ElType = 'action';
    for (const n of nodes) {
      if (n instanceof HTMLElement && n.classList.contains('el') && n.dataset.type) {
        lastType = n.dataset.type as ElType;
        const r = this.rich(n);
        blocks.push({ type: lastType, text: r.text, ...(r.fmt ? { fmt: r.fmt } : {}), ...(n.dataset.dual ? { dual: true } : {}) });
      } else {
        const t = (n.textContent ?? '').replace(/ /g, ' ');
        if (t || n.nodeName === 'BR' || n.nodeName === 'DIV') blocks.push({ type: lastType, text: t.replace(/\n/g, ' ') });
      }
    }
    if (!blocks.length) blocks.push({ type: 'action', text: '' });
    this.render(blocks);
    this.setCaret(caret);
  }

  /* ------------------------------------------------------------------ */
  /* History                                                             */
  /* ------------------------------------------------------------------ */

  private pushHistory(state: HistoryState) {
    this.history = this.history.slice(0, this.hIndex + 1);
    this.history.push(state);
    if (this.history.length > 500) this.history.shift();
    this.hIndex = this.history.length - 1;
  }

  private commit() {
    window.clearTimeout(this.typingTimer);
    this.pending = false;
    const state: HistoryState = { blocks: this.getBlocks(), caret: this.getCaret() };
    const prev = this.history[this.hIndex];
    if (prev && JSON.stringify(prev.blocks) === JSON.stringify(state.blocks)) {
      prev.caret = state.caret;
      return;
    }
    this.pushHistory(state);
    this.opts.onChange?.();
  }

  private scheduleCommit() {
    this.pending = true;
    window.clearTimeout(this.typingTimer);
    this.typingTimer = window.setTimeout(() => this.commit(), 700);
  }

  private restore(state: HistoryState) {
    this.render(state.blocks);
    this.root.focus({ preventScroll: true });
    this.setCaret(state.caret);
    this.ensureCaretVisible();
    this.hideAutocomplete();
    this.opts.onChange?.();
    this.onSelectionChange(true);
  }

  /* ------------------------------------------------------------------ */
  /* Editing operations                                                  */
  /* ------------------------------------------------------------------ */

  /** Delete a selection that may span several blocks. Returns caret at start. */
  private deleteRange(sel: Sel): Caret {
    const els = this.els();
    const first = els[sel.start.b];
    const last = els[sel.end.b];
    const fr = this.rich(first);
    const lr = this.rich(last);
    const a = fr.text.slice(0, sel.start.o);
    const z = lr.text.slice(sel.end.o);
    const fmt = concatRuns(sliceRuns(fr.fmt, 0, sel.start.o), a.length, sliceRuns(lr.fmt, sel.end.o, lr.text.length));
    for (let i = sel.end.b; i > sel.start.b; i--) els[i].remove();
    this.setText(first, a + z, fmt);
    this.setCaret(sel.start);
    return sel.start;
  }

  private handleEnter() {
    if (!this.acceptSuggestionIfOpen()) {
      this.flush();
      const sel = this.getSel();
      if (!sel) return;
      const caret = sel.collapsed ? sel.end : this.deleteRange(sel);
      const els = this.els();
      const el = els[caret.b];
      const type = el.dataset.type as ElType;
      const text = this.textOf(el);

      if (text.trim() === '' && EMPTY_ENTER[type] && els.length > 1) {
        const to = EMPTY_ENTER[type]!;
        this.convertEmpty(el, to);
        this.setCaret(this.posOfEl(el, to === 'parenthetical' ? 1 : 0));
      } else if (caret.o === 0 && text.length > 0) {
        // Insert a fresh element above, keep the cursor on the current text.
        el.before(this.makeEl({ type, text: '' }));
        this.setCaret({ b: caret.b + 1, o: 0 });
      } else {
        let o = caret.o;
        // In a parenthetical, keep the closing ")" on this line.
        if (type === 'parenthetical' && text.endsWith(')') && o === text.length - 1) o = text.length;
        const before = text.slice(0, o);
        const after = text.slice(o);
        const fmt = this.rich(el).fmt;
        this.setText(el, before, sliceRuns(fmt, 0, o));
        const nextType = NEXT_ON_ENTER[type];
        const nb = this.makeEl({ type: after && type !== 'parenthetical' ? type : nextType, text: after, fmt: sliceRuns(fmt, o, text.length) });
        el.after(nb);
        this.setCaret({ b: caret.b + 1, o: 0 });
      }
      this.commit();
    }
    this.ensureCaretVisible();
    this.onSelectionChange(true);
  }

  private posOfEl(el: HTMLElement, o: number): Caret {
    return { b: this.els().indexOf(el), o };
  }

  private convertEmpty(el: HTMLElement, to: ElType) {
    el.dataset.type = to;
    delete el.dataset.dual;
    this.setText(el, to === 'parenthetical' ? '()' : '');
  }

  private handleTab(shift: boolean) {
    if (!shift && this.acceptSuggestionIfOpen()) return;
    const type = this.currentType();
    this.setType(shift ? SHIFT_TAB_NEXT[type] : TAB_NEXT[type]);
  }

  /** Returns true if handled (default prevented). */
  private handleBackspace(): boolean {
    const sel = this.getSel();
    if (!sel) return false;
    if (!sel.collapsed) {
      if (sel.start.b === sel.end.b) return false;
      this.flush();
      this.deleteRange(sel);
      this.commit();
      return true;
    }
    if (sel.start.o !== 0) return false;
    const els = this.els();
    const i = sel.start.b;
    const el = els[i];
    const text = this.textOf(el);
    this.flush();
    if (i === 0) {
      if (text === '' && el.dataset.type !== 'action') {
        this.convertEmpty(el, 'action');
        this.setCaret({ b: 0, o: 0 });
        this.commit();
      }
      return true;
    }
    const prev = els[i - 1];
    const prevText = this.textOf(prev);
    if (text === '') {
      el.remove();
      this.setCaret({ b: i - 1, o: prevText.length });
    } else if (prevText === '') {
      prev.remove();
      this.setCaret({ b: i - 1, o: 0 });
    } else {
      this.setText(prev, prevText + text, concatRuns(this.rich(prev).fmt, prevText.length, this.rich(el).fmt));
      el.remove();
      this.setCaret({ b: i - 1, o: prevText.length });
    }
    this.commit();
    return true;
  }

  private handleDelete(): boolean {
    const sel = this.getSel();
    if (!sel) return false;
    if (!sel.collapsed) {
      if (sel.start.b === sel.end.b) return false;
      this.flush();
      this.deleteRange(sel);
      this.commit();
      return true;
    }
    const els = this.els();
    const el = els[sel.start.b];
    const text = this.textOf(el);
    if (sel.start.o < text.length) return false;
    const next = els[sel.start.b + 1];
    if (!next) return true;
    this.flush();
    if (text === '') {
      el.remove();
      this.setCaret({ b: sel.start.b, o: 0 });
    } else {
      this.setText(el, text + this.textOf(next), concatRuns(this.rich(el).fmt, text.length, this.rich(next).fmt));
      next.remove();
      this.setCaret(sel.start);
    }
    this.commit();
    return true;
  }

  private insertBlocks(incoming: Block[]) {
    this.flush();
    // Pasted scenes are new scenes: they get their own ids.
    incoming = incoming.map(({ sid: _sid, ...b }) => b);
    let sel = this.getSel();
    if (!sel) return;
    const caret = sel.collapsed ? sel.start : this.deleteRange(sel);
    const el = this.els()[caret.b];
    const text = this.textOf(el);
    const before = text.slice(0, caret.o);
    const after = text.slice(caret.o);
    const fmt = this.rich(el).fmt;
    const fmtBefore = sliceRuns(fmt, 0, caret.o);
    const fmtAfter = sliceRuns(fmt, caret.o, text.length);

    if (incoming.length === 1) {
      const t = incoming[0].text;
      const mid = concatRuns(fmtBefore, before.length, incoming[0].fmt);
      this.setText(el, before + t + after, concatRuns(mid, before.length + t.length, fmtAfter));
      if (!text.trim() && incoming[0].type !== el.dataset.type) el.dataset.type = incoming[0].type;
      this.setCaret({ b: caret.b, o: before.length + t.length });
    } else {
      // Multiple elements: keep them as separate elements around the split point.
      const type = el.dataset.type as ElType;
      const list = [...incoming];
      let anchor = el;
      if (before.trim()) {
        this.setText(el, before, fmtBefore);
      } else {
        const first = list.shift()!;
        el.dataset.type = first.type;
        if (first.dual) el.dataset.dual = '1';
        else delete el.dataset.dual;
        this.setText(el, first.text, first.fmt);
      }
      let lastIdx = caret.b;
      for (const b of list) {
        const n = this.makeEl(b);
        anchor.after(n);
        anchor = n;
        lastIdx++;
      }
      const lastLen = this.textOf(anchor).length;
      if (after.trim()) anchor.after(this.makeEl({ type, text: after, fmt: fmtAfter }));
      this.setCaret({ b: lastIdx, o: lastLen });
    }
    this.commit();
    this.ensureCaretVisible();
  }

  private selectedBlocks(sel: Sel): Block[] {
    const blocks = this.getBlocks().slice(sel.start.b, sel.end.b + 1);
    if (!blocks.length) return [];
    const lastLen = sel.end.b - sel.start.b;
    const cut = (b: Block, s: number, e: number): Block => {
      const out: Block = { ...b, text: b.text.slice(s, e) };
      const fmt = sliceRuns(b.fmt, s, e);
      if (fmt) out.fmt = fmt;
      else delete out.fmt;
      return out;
    };
    blocks[lastLen] = cut(blocks[lastLen], 0, sel.end.o);
    blocks[0] = cut(blocks[0], sel.start.o, blocks[0].text.length);
    return blocks;
  }

  /* ------------------------------------------------------------------ */
  /* Event handlers                                                      */
  /* ------------------------------------------------------------------ */

  private onKeyDown(e: KeyboardEvent) {
    if (this.composing || e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;

    if (!this.ac.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = this.acItems.length;
        if (this.acIndex < 0) this.acIndex = e.key === 'ArrowDown' ? 0 : n - 1;
        else this.acIndex = (this.acIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        this.paintAutocomplete();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.acDismissed = this.currentEl;
        this.hideAutocomplete();
        return;
      }
    }

    if (mod && !e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (mod && !e.altKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      this.toggleFormat(e.key.toLowerCase() as Flag);
      return;
    }
    if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'x') {
      e.preventDefault();
      this.toggleFormat('s');
      return;
    }

    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        this.handleEnter();
        return;
      case 'Tab':
        e.preventDefault();
        this.handleTab(e.shiftKey);
        return;
      case 'Backspace':
        if (this.handleBackspace()) e.preventDefault();
        return;
      case 'Delete':
        if (this.handleDelete()) e.preventDefault();
        return;
    }

    // Typing over a selection that spans several blocks.
    if (e.key.length === 1 && !mod) {
      const sel = this.getSel();
      if (sel && !sel.collapsed && sel.start.b !== sel.end.b) {
        this.flush();
        this.deleteRange(sel);
        this.pending = true;
      }
    }
  }

  private onBeforeInput(e: InputEvent) {
    const t = e.inputType;
    if (t === 'insertParagraph' || t === 'insertLineBreak') {
      e.preventDefault();
      this.handleEnter();
    } else if (t === 'historyUndo') {
      e.preventDefault();
      this.undo();
    } else if (t === 'historyRedo') {
      e.preventDefault();
      this.redo();
    } else if (t.startsWith('format') || t === 'insertFromDrop' || t === 'deleteByDrag') {
      e.preventDefault();
    }
  }

  private onInput() {
    if (this.composing) return;
    this.normalize();
    const sel = this.getSel();
    if (sel) {
      const el = this.els()[sel.end.b];
      const type = el.dataset.type as ElType;
      const text = this.textOf(el);
      // Smart conversions while typing.
      if (!this.prefs.smartType) {
        /* automatic conversions switched off */
      } else if (type === 'action' && SCENE_PREFIX.test(text) && sel.end.o === text.length) {
        el.dataset.type = 'scene';
      } else if (type === 'dialogue' && text === '(') {
        el.dataset.type = 'parenthetical';
        this.setText(el, '()');
        this.setCaret({ b: sel.end.b, o: 1 });
      }
    }
    this.scheduleCommit();
    this.onSelectionChange(true);
    this.updateAutocomplete();
    if (this.prefs.typewriter) this.centerCaret();
  }

  /** Typewriter scrolling: keep the current line in the middle of the screen. */
  centerCaret() {
    const el = this.currentEl;
    const scroller = this.root.closest('main');
    if (!el || !scroller) return;
    const r = el.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    const delta = r.top + r.height / 2 - (box.top + box.height / 2);
    if (Math.abs(delta) > 4) scroller.scrollTop += delta;
  }

  private onPaste(e: ClipboardEvent) {
    e.preventDefault();
    const dt = e.clipboardData;
    if (!dt) return;
    const json = dt.getData(CLIP_MIME);
    if (json) {
      try {
        // Clipboard data can come from any page: validate it like an imported .terra file.
        const blocks = parseTerra(JSON.stringify({ blocks: JSON.parse(json) })).blocks;
        if (Array.isArray(blocks) && blocks.length) return this.insertBlocks(blocks);
      } catch {
        /* fall through */
      }
    }
    const text = dt.getData('text/plain').replace(/\r\n?/g, '\n');
    if (!text) return;
    if (!text.includes('\n')) {
      this.insertBlocks([{ type: this.currentType(), text }]);
      return;
    }
    const { blocks } = parseFountain(text.replace(/^\n+|\n+$/g, ''));
    if (blocks.length) this.insertBlocks(blocks);
  }

  private onCopy(e: ClipboardEvent, cut: boolean) {
    const sel = this.getSel();
    if (!sel || sel.collapsed || !e.clipboardData) return;
    e.preventDefault();
    const blocks = this.selectedBlocks(sel);
    const plain =
      blocks.length === 1 ? blocks[0].text : toFountain(blocks).trim();
    e.clipboardData.setData('text/plain', plain);
    try {
      e.clipboardData.setData(CLIP_MIME, JSON.stringify(blocks));
    } catch {
      /* custom formats unsupported */
    }
    if (cut) {
      this.flush();
      this.deleteRange(sel);
      this.commit();
    }
  }

  private onSelectionChange(force = false) {
    const s = window.getSelection();
    if (!s || !s.rangeCount || !this.root.contains(s.focusNode)) {
      if (!force) return;
    }
    const el = s?.focusNode ? this.blockOf(s.focusNode) : null;
    const moved = Boolean(el && (el !== this.currentEl || el.dataset.type !== this.acLineType));
    if (el && (el !== this.currentEl || force)) {
      if (el !== this.currentEl) this.acDismissed = null;
      this.currentEl?.classList.remove('current');
      this.currentEl = el;
      el.classList.add('current');
    }
    // Arrived on a new line (or its type changed, e.g. Tab -> Character): offer the dropdown.
    if (el && moved) {
      this.acLineType = el.dataset.type;
      if (document.activeElement === this.root) this.updateAutocomplete(true);
      else this.hideAutocomplete();
    }
    if (this.currentEl && this.currentEl.isConnected) {
      this.opts.onCaretMove?.(this.currentType(), this.currentIndex());
    }
    if (!force && !moved) {
      // Hide suggestions when the caret leaves the end of the line.
      const sel = this.getSel();
      if (!this.ac.hidden && sel && sel.end.o !== this.textOf(this.els()[sel.end.b]).length) this.hideAutocomplete();
    }
  }

  private ensureCaretVisible() {
    const s = window.getSelection();
    if (!s?.rangeCount) return;
    const el = this.blockOf(s.focusNode);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const scroller = this.root.closest('main');
    const box = scroller?.getBoundingClientRect();
    if (box && (rect.bottom > box.bottom - 40 || rect.top < box.top + 40)) {
      el.scrollIntoView({ block: 'nearest' });
      scroller!.scrollTop += rect.bottom > box.bottom - 40 ? 80 : -80;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Autocomplete                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Dropdown contents for the current line.
   * `auto` = opened because the cursor arrived on the line (not because of typing):
   * then only offer a list on an empty line, and preselect nothing so Enter/Tab
   * keep their normal meaning until the user picks with the arrow keys.
   */
  private suggestionsFor(type: ElType, text: string, index: number, auto: boolean): SuggestionList | null {
    const up = text.toUpperCase();
    const typed = up.trim();
    const blocks = this.getBlocks();
    const freq = (pick: (b: Block) => string | null) => {
      const counts = new Map<string, number>();
      blocks.forEach((b, i) => {
        if (i === index) return;
        const v = pick(b);
        if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
      });
      return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    };

    if (type === 'character') {
      const names = freq((b) => (b.type === 'character' ? characterName(b.text) : null));
      if (!typed) {
        if (!names.length) return null;
        return {
          title: t('ac.characters'),
          items: names.map(([n, c]) => ({ label: n, apply: n, hint: t('ac.lines', { n: c }) })),
          preselect: false,
        };
      }
      if (auto) return null;
      // Name typed in full (or with an opening bracket): offer extensions.
      const base = characterName(up);
      const bracket = up.match(/\(([^)]*)$/);
      if (names.some(([n]) => n === base) && (bracket || up.endsWith(' ') || up === base)) {
        const partial = bracket ? bracket[1].trim() : '';
        const items = EXTENSIONS.filter((x) => x.code.startsWith(partial)).map((x) => ({
          label: `${base} (${x.code})`,
          apply: `${base} (${x.code})`,
          hint: t(x.hint),
        }));
        return items.length ? { title: t('ac.extension'), items, preselect: Boolean(bracket) } : null;
      }
      const items = names.filter(([n]) => n.startsWith(typed) && n !== typed).map(([n, c]) => ({ label: n, apply: n, hint: t('ac.lines', { n: c }) }));
      return items.length ? { title: t('ac.characters'), items, preselect: true } : null;
    }

    if (type === 'scene') {
      const m = up.match(SCENE_PREFIX);
      if (!m) {
        if (auto && typed) return null;
        const items = SCENE_PREFIXES.filter((p) => p.code.startsWith(up) && p.code !== up).map((p) => ({
          label: p.code.trim(),
          apply: p.code,
          hint: t(p.hint),
        }));
        return items.length ? { title: t('ac.sceneType'), items, preselect: Boolean(typed) } : null;
      }
      const prefix = up.slice(0, m[0].length).trimEnd() + ' ';
      const rest = up.slice(m[0].length).trimStart();
      const dash = rest.lastIndexOf(' - ');
      if (dash >= 0 || rest.endsWith(' -')) {
        const loc = dash >= 0 ? rest.slice(0, dash) : rest.slice(0, -2);
        const time = dash >= 0 ? rest.slice(dash + 3) : '';
        if (auto && time) return null;
        const items = TIMES.filter((x) => x.startsWith(time) && x !== time).map((x) => ({ label: x, apply: `${prefix}${loc} - ${x}` }));
        return items.length ? { title: t('ac.time'), items, preselect: Boolean(time) } : null;
      }
      if (auto && rest) return null;
      const locs = freq((b) => {
        if (b.type !== 'scene') return null;
        const bu = b.text.toUpperCase();
        const bm = bu.match(SCENE_PREFIX);
        const body = bm ? bu.slice(bm[0].length).trim() : bu.trim();
        return body.split(' - ')[0].trim() || null;
      });
      const items = locs
        .filter(([l]) => l.startsWith(rest) && l !== rest)
        .map(([l, c]) => ({ label: l, apply: `${prefix}${l} - `, hint: t('ac.lines', { n: c }) }));
      return items.length ? { title: t('ac.location'), items, preselect: Boolean(rest) } : null;
    }

    if (type === 'transition') {
      if (auto && typed) return null;
      const items = TRANSITIONS.filter((x) => x.startsWith(up) && x !== up).map((x) => ({ label: x, apply: x }));
      return items.length ? { title: t('ac.transition'), items, preselect: Boolean(typed) } : null;
    }
    return null;
  }

  private updateAutocomplete(auto = false) {
    if (!this.prefs.autocomplete) return this.hideAutocomplete();
    const sel = this.getSel();
    if (!sel || !sel.collapsed) return this.hideAutocomplete();
    const el = this.els()[sel.end.b];
    if (!el) return this.hideAutocomplete();
    const text = this.textOf(el);
    if (sel.end.o !== text.length) return this.hideAutocomplete();
    if (auto && this.acDismissed === el) return; // closed with Esc on this line
    const list = this.suggestionsFor(el.dataset.type as ElType, text, sel.end.b, auto);
    if (!list) return this.hideAutocomplete();
    this.acItems = list.items;
    this.acTitle = list.title;
    this.acIndex = list.preselect ? 0 : -1;
    this.paintAutocomplete();
    this.ac.hidden = false;
    this.ensureCaretVisible();
    this.positionAutocomplete();
  }

  /** Place the dropdown under the caret (or above it when there is no room below). */
  private positionAutocomplete() {
    if (this.ac.hidden) return;
    const s = window.getSelection();
    if (!s?.rangeCount || !this.root.contains(s.focusNode)) return this.hideAutocomplete();
    const el = this.blockOf(s.focusNode);
    if (!el) return this.hideAutocomplete();
    const r = s.getRangeAt(0).cloneRange();
    let rect = r.getBoundingClientRect();
    if (!rect.height) rect = el.getBoundingClientRect();
    const h = this.ac.offsetHeight;
    const below = rect.bottom + 4;
    let top = below + h > window.innerHeight - 8 && rect.top - h - 4 > 8 ? rect.top - h - 4 : below;
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8)); // always fully on screen
    const left = Math.min(rect.left, window.innerWidth - this.ac.offsetWidth - 8);
    this.ac.style.top = `${top}px`;
    this.ac.style.left = `${Math.max(8, left)}px`;
  }

  private paintAutocomplete() {
    const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    this.ac.innerHTML =
      `<div class="ac-head">${escHtml(this.acTitle)}</div><div class="ac-list">` +
      this.acItems
        .map(
          (s, i) =>
            `<div class="ac-item${i === this.acIndex ? ' active' : ''}" role="option" aria-selected="${i === this.acIndex}" data-i="${i}"><span class="ac-label">${escHtml(s.label)}</span>${s.hint ? `<span class="ac-hint">${escHtml(s.hint)}</span>` : ''}</div>`,
        )
        .join('') +
      `</div><div class="ac-foot">${escHtml(t('ac.keys'))}</div>`;
    this.ac.querySelector<HTMLElement>('.ac-item.active')?.scrollIntoView({ block: 'nearest' });
  }

  private hideAutocomplete() {
    this.ac.hidden = true;
    this.acItems = [];
  }

  /** Enter/Tab: accept the highlighted item. Nothing highlighted = close and act normally. */
  private acceptSuggestionIfOpen(): boolean {
    if (this.ac.hidden || !this.acItems.length) return false;
    if (this.acIndex < 0) {
      this.hideAutocomplete();
      return false;
    }
    this.acceptSuggestion(this.acIndex);
    return true;
  }

  private acceptSuggestion(i: number) {
    const s = this.acItems[i];
    const sel = this.getSel();
    if (!s || !sel) return;
    const el = this.els()[sel.end.b];
    this.setText(el, s.apply);
    this.setCaret({ b: sel.end.b, o: s.apply.length });
    this.hideAutocomplete();
    this.commit();
    // Chain: after "INT. " offer locations, after a location offer times.
    if (s.apply.endsWith(' ')) this.updateAutocomplete(true);
  }
}