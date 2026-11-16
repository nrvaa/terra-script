/**
 * Screenplay PDF export without dependencies: lays the script out on a
 * Courier 12pt grid (10 characters per inch, 6 lines per inch), paginates it
 * with screenplay rules and writes a PDF using the built-in Courier fonts.
 *
 * The same layout drives the on-screen page view, the page count and the
 * runtime estimate, so all of them always agree with the PDF.
 */
import type { ReportLine } from './report';
import { expand, shiftRuns } from './rich';
import {
  DEFAULT_FOOTER,
  DEFAULT_HEADER,
  autoContdCues,
  elementStyle,
  sceneLabels,
  nextLetter,
  type Block,
  type ElementStyle,
  type Run,
  type ScriptLayout,
  type TitlePage,
} from './types';

type Font = 'R' | 'B' | 'I' | 'BI';
interface Seg {
  x: number; // in characters from the left margin (may be fractional/negative)
  text: string;
  font?: Font;
  underline?: boolean;
  strike?: boolean;
}
/**
 * A printed line. src/line: which script block (and which wrapped line of it)
 * it came from. head: first line of a scene heading (label = its number).
 */
type Row = Seg[] & { src?: number; line?: number; head?: string };

/** Mark rows with the block they belong to (used to show the same page breaks on screen). */
function tag(rows: Row[], src: number): Row[] {
  rows.forEach((r, k) => {
    r.src = src;
    r.line = k;
  });
  return rows;
}

/** Everything that affects how the script is laid out. */
export type LayoutOptions = ScriptLayout & {
  /** Block indices marked as revised: asterisk in the right margin. */
  revised?: Set<number>;
  /** e.g. "Blue Rev. 16/11/2026" — shown in the header of revised pages. */
  revLabel?: string;
  /** Script title for the {title} header token. */
  title?: string;
};

export interface PdfOptions extends LayoutOptions {
  titlePage?: TitlePage | null;
  /** Include the screenplay pages (default true). */
  script?: boolean;
  /** Report appended after the script on its own, unnumbered pages. */
  report?: ReportLine[] | null;
}

const PT = 72; // points per inch
const CHAR = 7.2; // Courier 12pt advance width
const LINE = 12;
const LEFT = 1.5 * PT;
const TOP = 1 * PT;
const BOTTOM = 1 * PT;
const WIDTH = 60; // text area: 6 inches

const PAPER = {
  letter: { w: 612, h: 792 },
  a4: { w: 595.28, h: 841.89 },
};

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let cur = '';
    for (let w of words) {
      while (w.length > width) {
        if (cur) {
          out.push(cur);
          cur = '';
        }
        out.push(w.slice(0, width));
        w = w.slice(width);
      }
      if (!cur) cur = w;
      else if (cur.length + 1 + w.length <= width) cur += ' ' + w;
      else {
        out.push(cur);
        cur = w;
      }
    }
    out.push(cur);
  }
  return out.length ? out : [''];
}

/**
 * Character offset where each wrapped line of `text` starts. Both the PDF and
 * the screen break lines with this, so they always agree.
 */
export function lineStarts(text: string, width: number): number[] {
  const starts: number[] = [];
  let curStart = -1;
  let curLen = 0;
  for (const m of text.matchAll(/\S+/g)) {
    let w = m[0];
    let pos = m.index!;
    while (w.length > width) {
      if (curStart >= 0) {
        starts.push(curStart);
        curStart = -1;
        curLen = 0;
      }
      starts.push(pos);
      w = w.slice(width);
      pos += width;
    }
    if (curStart < 0) {
      curStart = pos;
      curLen = w.length;
    } else if (curLen + 1 + w.length <= width) curLen += 1 + w.length;
    else {
      starts.push(curStart);
      curStart = pos;
      curLen = w.length;
    }
  }
  starts.push(curStart < 0 ? 0 : curStart);
  return starts;
}

/** Wrap width (characters) the PDF uses for each element type. */
export const WRAP_WIDTH: Record<string, number> = {
  dialogue: 35,
  lyrics: 35,
  parenthetical: 25,
  transition: 25,
};

/** Lines per page and page height for a paper size. */
export function pageGeometry(paper: 'letter' | 'a4') {
  const size = PAPER[paper];
  return { linesPerPage: Math.floor((size.h - TOP - BOTTOM) / LINE), heightIn: size.h / PT, widthIn: size.w / PT };
}

const fontOf = (bold: boolean, italic: boolean): Font => (bold ? (italic ? 'BI' : 'B') : italic ? 'I' : 'R');

/**
 * Wrap a block's text (keeping its inline formatting) into printable lines.
 * Each line is a list of segments with their offset from the line start.
 */
function richLines(text: string, fmt: Run[] | undefined, width: number, st: Pick<ElementStyle, 'caps' | 'bold' | 'italic' | 'underline'>): { len: number; segs: (Omit<Seg, 'x'> & { dx: number })[] }[] {
  const flags = expand(text.length, fmt);
  const starts = lineStarts(text, width);
  return starts.map((s, k) => {
    const next = starts[k + 1] ?? text.length;
    let e = next;
    while (e > s && /\s/.test(text[e - 1])) e--;
    const segs: (Omit<Seg, 'x'> & { dx: number })[] = [];
    let a = s;
    while (a < e) {
      let b = a + 1;
      while (b < e && flags[b] === flags[a]) b++;
      const f = flags[a];
      let t = text.slice(a, b);
      if (st.caps) t = t.toUpperCase();
      segs.push({
        dx: a - s,
        text: t,
        font: fontOf(st.bold || f.includes('b'), st.italic || f.includes('i')),
        underline: st.underline || f.includes('u'),
        strike: f.includes('s'),
      });
      a = b;
    }
    return { len: Math.max(0, e - s), segs };
  });
}

/** Lines as rows starting at column x (or aligned with `align`). */
function rowsOf(lines: ReturnType<typeof richLines>, x: number | ((len: number, k: number) => number)): Row[] {
  return lines.map((l, k) => {
    const x0 = typeof x === 'number' ? x : x(l.len, k);
    return l.segs.map(({ dx, ...seg }) => ({ ...seg, x: x0 + dx })) as Row;
  });
}

/* ------------------------------------------------------------------ */
/* Layout units                                                        */
/* ------------------------------------------------------------------ */

interface Unit {
  kind: 'plain' | 'scene' | 'dialogue' | 'dual' | 'act';
  before: number;
  rows: Row[];
  /** Dialogue only: index of rows that are parentheticals (avoid ending a page on them). */
  parenRows?: Set<number>;
  speaker?: string;
  /** Scene only: always starts a new page. */
  forceNew?: boolean;
  group?: Block[];
  gidx?: number[];
}

const DIALOGUE_PARTS = ['parenthetical', 'dialogue', 'lyrics'];

function buildUnits(blocks: Block[], opts: LayoutOptions): Unit[] {
  const units: Unit[] = [];
  // Keep each block's original index so rows can point back to it.
  const kept = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.type !== 'note' && b.type !== 'section');
  const src = kept.map((k) => k.b);
  const at = kept.map((k) => k.i);
  const labels = sceneLabels(blocks, opts);
  const contdWord = (opts.contdText || "CONT'D").trim();
  const autoContd = opts.autoContd ? autoContdCues(blocks) : new Set<number>();
  const style = (b: Block) => elementStyle(opts, b.type);
  const side = opts.sceneNumberSide ?? 'both';

  const dialogueRows = (group: Block[], gidx: number[], charX: number, offset: number, width: number) => {
    const rows: Row[] = [];
    const paren = new Set<number>();
    group.forEach((b, gi) => {
      const st = style(b);
      if (gi > 0) for (let k = 0; k < st.before; k++) rows.push([]);
      const first = rows.length;
      if (b.type === 'character') {
        const lines = richLines(b.text.trim(), shiftRuns(b.fmt, -(b.text.length - b.text.trimStart().length), b.text.trim().length), 500, st);
        const r = rowsOf(lines.slice(0, 1), offset + charX);
        if (autoContd.has(gidx[gi])) {
          const len = lines[0]?.len ?? 0;
          r[0].push({ x: offset + charX + len + 1, text: `(${contdWord})`, font: fontOf(st.bold, st.italic) });
        }
        rows.push(...r);
      } else if (b.type === 'parenthetical') {
        let text = b.text;
        let fmt = b.fmt;
        const trimmed = text.trim();
        if (trimmed && !trimmed.startsWith('(')) {
          const lead = text.length - text.trimStart().length;
          fmt = shiftRuns(fmt, 1 - lead, trimmed.length + 2);
          text = `(${trimmed})`;
        }
        const pw = Math.max(10, width - 10);
        rowsOf(richLines(text, fmt, pw, st), (_, k) => offset + 5 + (k ? 1 : 0)).forEach((r) => {
          paren.add(rows.length);
          rows.push(r);
        });
      } else {
        rows.push(...rowsOf(richLines(b.text, b.fmt, width, st), offset));
      }
      if (gidx[gi] !== undefined) tag(rows.slice(first), gidx[gi]);
    });
    return { rows, paren };
  };

  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    const st = style(b);

    if (b.type === 'character') {
      const group: Block[] = [b];
      const gidx = [at[i]];
      while (i + 1 < src.length && DIALOGUE_PARTS.includes(src[i + 1].type)) {
        group.push(src[++i]);
        gidx.push(at[i]);
      }
      const prev = units[units.length - 1];
      if (b.dual && prev?.kind === 'dialogue' && prev.group && prev.gidx) {
        // Re-lay the previous speech and this one side by side.
        const left = dialogueRows(prev.group, prev.gidx, 8, 0, 28);
        const right = dialogueRows(group, gidx, 8, 31, 28);
        const rows: Row[] = [];
        for (let r = 0; r < Math.max(left.rows.length, right.rows.length); r++) {
          const row: Row = [...(left.rows[r] ?? []), ...(right.rows[r] ?? [])];
          const from = left.rows[r] ?? right.rows[r];
          row.src = from?.src;
          row.line = from?.line;
          rows.push(row);
        }
        units[units.length - 1] = { kind: 'dual', before: prev.before, rows };
        continue;
      }
      const { rows, paren } = dialogueRows(group, gidx, 10, 10, 35);
      units.push({ kind: 'dialogue', before: st.before, rows, parenRows: paren, speaker: b.text.trim().toUpperCase(), group, gidx });
      continue;
    }

    const lines = (width: number) => richLines(b.text, b.fmt, width, st);
    switch (b.type) {
      case 'scene': {
        const rows = rowsOf(lines(WIDTH), 0);
        if (!rows.length) rows.push([]);
        const label = labels.get(at[i]) ?? '';
        if (opts.sceneNumbers && label) {
          const f = fontOf(st.bold, false);
          if (side !== 'right') rows[0].unshift({ x: -1.5 - label.length, text: label, font: f });
          if (side !== 'left') rows[0].push({ x: WIDTH + 1.5, text: label, font: f });
        }
        rows[0].head = label;
        units.push({ kind: 'scene', before: st.before, rows, forceNew: b.newPage });
        break;
      }
      case 'transition':
        units.push({ kind: 'plain', before: st.before, rows: rowsOf(lines(25), (len) => WIDTH - len) });
        break;
      case 'text':
        units.push({ kind: 'plain', before: st.before, rows: rowsOf(lines(WIDTH), (len) => (WIDTH - len) / 2) });
        break;
      case 'act':
      case 'endact':
        units.push({ kind: b.type === 'act' ? 'act' : 'plain', before: st.before, rows: rowsOf(lines(WIDTH), (len) => (WIDTH - len) / 2) });
        break;
      case 'parenthetical':
      case 'dialogue':
      case 'lyrics': {
        // Orphaned dialogue part (no character before it).
        const { rows } = dialogueRows([b], [at[i]], 10, 10, 35);
        units.push({ kind: 'plain', before: 0, rows });
        break;
      }
      default:
        units.push({ kind: 'plain', before: st.before, rows: rowsOf(lines(WIDTH), 0) });
    }
    const last = units[units.length - 1];
    if (last && last.rows[0]?.src === undefined) {
      const head = last.rows[0]?.head;
      tag(last.rows, at[i]);
      if (head !== undefined) last.rows[0].head = head;
    }
  }

  // Revision asterisks near the right edge (clear of right-side scene numbers).
  if (opts.revised?.size) {
    const starX = (pageGeometry(opts.paper).widthIn - 1.5 - 0.25) * 10;
    for (const u of units) for (const r of u.rows) if (r.src !== undefined && opts.revised.has(r.src)) r.push({ x: starX, text: '*' });
  }
  return units;
}

/* ------------------------------------------------------------------ */
/* Pagination                                                          */
/* ------------------------------------------------------------------ */

export interface LaidPage {
  rows: Row[];
  /** Page number as printed: 12, or 12A on locked pages. */
  label: string;
  /** Rows before the first script line (CONTINUED:, NAME (CONT'D)). */
  lead: number;
  /** The page begins in the middle of a scene (scene continueds on). */
  continued: boolean;
  /** Any revised line on this page. */
  revised: boolean;
}

function paginate(units: Unit[], linesPerPage: number, opts: LayoutOptions, anchors: Map<number, { label: string; line: number }>): LaidPage[] {
  const capacity = linesPerPage - (opts.sceneContinueds ? 4 : 0);
  type P = Row[] & { label?: string };
  const pages: P[] = [[]];
  let page: P = pages[0];
  const room = () => capacity - page.length;
  const newPage = () => {
    page = [];
    pages.push(page);
  };
  const isAnchor = (r: Row) => {
    if (r.src === undefined) return null;
    const a = anchors.get(r.src);
    return a && (r.line ?? 0) === a.line ? a : null;
  };
  const put = (rows: Row[], before: number) => {
    if (page.length) for (let k = 0; k < before; k++) page.push([]);
    for (const r of rows) {
      const a = isAnchor(r);
      // A locked page starts here: break even if there is room left.
      if (a && page.some((x) => x.src !== undefined)) {
        while (page.length && !page[page.length - 1].length) page.pop();
        newPage();
      }
      if (room() <= 0) newPage();
      if (a) page.label = a.label;
      page.push(r);
    }
  };
  const need = (u: Unit) => (page.length ? u.before : 0) + u.rows.length;
  const more = opts.more !== false;
  const moreWord = `(${(opts.moreText || 'MORE').trim()})`;
  const contdWord = (opts.contdText || "CONT'D").trim();

  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if ((u.kind === 'act' || u.forceNew) && page.length) newPage();

    if (u.kind === 'scene') {
      // Keep the heading with at least two lines of what follows.
      const next = units[i + 1];
      const follow = next ? next.before + Math.min(2, next.rows.length) : 0;
      if (need(u) + follow > room() && page.length) newPage();
      put(u.rows, u.before);
      continue;
    }

    if (need(u) <= room()) {
      put(u.rows, u.before);
      continue;
    }

    const avail = room() - (page.length ? u.before : 0);

    if (u.kind === 'plain' && u.rows.length >= 4 && avail >= 2 && u.rows.length - avail >= 2) {
      put(u.rows.slice(0, avail), u.before);
      newPage();
      put(u.rows.slice(avail), 0);
      continue;
    }

    if (u.kind === 'dialogue' && more) {
      let rows = u.rows;
      let before = u.before;
      let shift = 0; // how many body rows earlier pages already consumed
      const name = u.speaker ?? '';
      const contd = new RegExp(contdWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(name) ? name : `${name} (${contdWord})`;
      // Split across as many pages as needed: NAME / lines / (MORE) | NAME (CONT'D) / rest.
      while ((page.length ? before : 0) + rows.length > room()) {
        const space = room() - (page.length ? before : 0);
        let fit = space - 2; // minus the name row and the (MORE) row
        while (fit > 0 && u.parenRows?.has(fit + shift)) fit--; // don't end on a parenthetical
        const body = rows.length - 1;
        if (fit < 2 || body - fit < 1) {
          if (!page.length) {
            // Taller than a full page and cannot split nicely: force it.
            fit = Math.max(1, space - 2);
          } else {
            newPage();
            before = 0;
            continue;
          }
        }
        put([rows[0], ...rows.slice(1, 1 + fit), [{ x: 20, text: moreWord }]], before);
        newPage();
        rows = [[{ x: 20, text: contd }], ...rows.slice(1 + fit)];
        shift += fit;
        before = 0;
      }
      put(rows, before);
      continue;
    }

    if (page.length) newPage();
    put(u.rows, u.before);
  }

  // Drop trailing empty page.
  if (pages.length > 1 && !pages[pages.length - 1].length) pages.pop();

  // Page labels: locked pages keep theirs; extra pages after them become 12A, 12B…
  const labels: string[] = [];
  pages.forEach((p, k) => {
    if (p.label) labels.push(p.label);
    else if (anchors.size && k > 0) labels.push(nextLetter(labels[k - 1]));
    else labels.push(String(k + 1));
  });

  // Scene continueds.
  const out: LaidPage[] = [];
  let scene: string | null = null;
  pages.forEach((p, k) => {
    const first = p.find((r) => r.src !== undefined);
    const continued = Boolean(opts.sceneContinueds && k > 0 && scene !== null && first && first.head === undefined);
    let rows: Row[] = p;
    if (continued) {
      const top: Row = [{ x: 0, text: 'CONTINUED:' }];
      if (opts.sceneNumbers && scene) {
        const side = opts.sceneNumberSide ?? 'both';
        if (side !== 'right') top.unshift({ x: -1.5 - scene.length, text: scene });
        if (side !== 'left') top.push({ x: WIDTH + 1.5, text: scene });
      }
      rows = [top, [], ...p];
      const prev = out[k - 1];
      while (prev.rows.length < linesPerPage - 1) prev.rows.push([]);
      prev.rows.push([{ x: WIDTH - 11, text: '(CONTINUED)' }]);
    }
    for (const r of p) if (r.head !== undefined) scene = r.head;
    const lead = rows.findIndex((r) => r.src !== undefined);
    out.push({
      rows,
      label: labels[k],
      lead: Math.max(0, lead),
      continued,
      revised: Boolean(opts.revised?.size && p.some((r) => r.src !== undefined && opts.revised!.has(r.src))),
    });
  });
  return out;
}

/** Locked page anchors stored on blocks (only when pages are locked). */
function anchorsOf(blocks: Block[], opts: LayoutOptions) {
  const m = new Map<number, { label: string; line: number }>();
  if (opts.pagesLocked) blocks.forEach((b, i) => b.pg && m.set(i, { label: b.pg, line: b.pgLine ?? 0 }));
  return m;
}

/* ------------------------------------------------------------------ */
/* Header / footer                                                     */
/* ------------------------------------------------------------------ */

export interface PageDecor {
  header: [string, string, string];
  footer: [string, string, string];
}

/** Header and footer text of a script page (tokens resolved). */
export function pageDecor(opts: LayoutOptions, page: LaidPage, index: number): PageDecor {
  const empty: PageDecor = { header: ['', '', ''], footer: ['', '', ''] };
  if (index === 0 && !opts.firstPageHeader) return empty;
  const rev = opts.revMarks && page.revised && opts.revLabel ? opts.revLabel : '';
  const fill = (s: string) =>
    s
      .replace(/\{page\}/gi, page.label)
      .replace(/\{title\}/gi, opts.title ?? '')
      .replace(/\{date\}/gi, new Date().toLocaleDateString())
      .replace(/\{rev\}/gi, rev)
      .trim();
  const hdr = opts.header ?? DEFAULT_HEADER;
  const header = hdr.map(fill) as [string, string, string];
  // Revised pages carry the revision label even without a {rev} token.
  if (rev && !hdr.some((s) => /\{rev\}/i.test(s))) header[2] = header[2] ? `${rev}   ${header[2]}` : rev;
  return { header, footer: (opts.footer ?? DEFAULT_FOOTER).map(fill) as [string, string, string] };
}

/* ------------------------------------------------------------------ */
/* Title page                                                          */
/* ------------------------------------------------------------------ */

function titleRows(tp: TitlePage, linesPerPage: number, centerX: number): Row[] {
  const rows: Row[] = Array.from({ length: linesPerPage }, () => []);
  const center = (s: string, font?: Font, underline?: boolean): Seg => ({ x: centerX - s.length / 2, text: s, font, underline });
  const up = (s: string) => s.toUpperCase();
  let r = 18;
  for (const l of wrap(up(tp.title.trim()), 50)) rows[r++] = [center(l, 'B', true)];
  r += 3;
  if (tp.credit.trim()) {
    rows[r] = [center(tp.credit.trim())];
    r += 2;
  }
  for (const l of tp.author.split('\n').filter((s) => s.trim())) rows[r++] = [center(l.trim())];
  if (tp.source.trim()) {
    r += 3;
    for (const l of tp.source.split('\n').flatMap((s) => wrap(s.trim(), 50))) rows[r++] = [center(l)];
  }
  // Contact (bottom left) and draft date (bottom right).
  const lines = (s: string, w: number) =>
    s.split('\n').map((x) => x.trim()).filter(Boolean).flatMap((x) => wrap(x, w)).slice(-12);
  const contact = lines(tp.contact, 32);
  const date = lines(tp.draftDate, 26);
  const bottom = linesPerPage - 1;
  contact.forEach((l, k) => rows[bottom - (contact.length - 1 - k)].push({ x: 0, text: l }));
  date.forEach((t, k) => rows[bottom - (date.length - 1 - k)].push({ x: WIDTH - t.length, text: t }));
  return rows;
}

/* ------------------------------------------------------------------ */
/* PDF writer                                                          */
/* ------------------------------------------------------------------ */

const WIN_ANSI: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

function pdfString(s: string): string {
  let out = '(';
  for (const ch of s.normalize('NFC')) {
    const c = ch.codePointAt(0)!;
    let byte: number;
    if (c >= 0x20 && c < 0x7f) byte = c;
    else if (c >= 0xa0 && c <= 0xff) byte = c;
    else byte = WIN_ANSI[c] ?? 0x3f; // '?'
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += '\\' + String.fromCharCode(byte);
    else if (byte < 0x80) out += String.fromCharCode(byte);
    else out += '\\' + byte.toString(8).padStart(3, '0');
  }
  return out + ')';
}

const FONT_NAME: Record<Font, string> = { R: 'F1', B: 'F2', I: 'F3', BI: 'F4' };
const num = (n: number) => (Math.round(n * 100) / 100).toString();

interface OutPage {
  rows: Row[];
  decor?: PageDecor;
  watermark?: string;
}

function pageStream(p: OutPage, pageH: number, pageW: number): string {
  const ops: string[] = [];
  if (p.watermark) {
    // Big light-grey diagonal text behind everything.
    const text = p.watermark.toUpperCase();
    const diag = Math.hypot(pageW, pageH);
    const size = Math.min(110, (diag * 0.7) / Math.max(1, text.length * 0.62));
    const width = text.length * size * 0.62;
    const c = Math.SQRT1_2;
    const x = pageW / 2 - (width / 2) * c + (size * 0.35) * c;
    const y = pageH / 2 - (width / 2) * c - (size * 0.35) * c;
    ops.push(`q 0.86 g BT /F5 ${num(size)} Tf ${num(c)} ${num(c)} ${num(-c)} ${num(c)} ${num(x)} ${num(y)} Tm ${pdfString(text)} Tj ET Q`);
  }
  const baseline = (r: number) => pageH - TOP - r * LINE - 9;
  p.rows.forEach((row, r) => {
    for (const seg of row) {
      if (!seg.text) continue;
      const x = LEFT + seg.x * CHAR;
      const y = baseline(r);
      ops.push(`BT /${FONT_NAME[seg.font ?? 'R']} 12 Tf ${num(x)} ${num(y)} Td ${pdfString(seg.text)} Tj ET`);
      const w = seg.text.length * CHAR;
      if (seg.underline) ops.push(`0.6 w ${num(x)} ${num(y - 1.6)} m ${num(x + w)} ${num(y - 1.6)} l S`);
      if (seg.strike) ops.push(`0.6 w ${num(x)} ${num(y + 3.4)} m ${num(x + w)} ${num(y + 3.4)} l S`);
    }
  });
  if (p.decor) {
    const slots = (texts: [string, string, string], y: number) => {
      const [l, c, rt] = texts;
      if (l) ops.push(`BT /F1 12 Tf ${num(LEFT)} ${num(y)} Td ${pdfString(l)} Tj ET`);
      if (c) ops.push(`BT /F1 12 Tf ${num(LEFT + ((WIDTH - c.length) / 2) * CHAR)} ${num(y)} Td ${pdfString(c)} Tj ET`);
      if (rt) ops.push(`BT /F1 12 Tf ${num(pageW - PT - rt.length * CHAR)} ${num(y)} Td ${pdfString(rt)} Tj ET`);
    };
    slots(p.decor.header, pageH - 0.5 * PT - 9);
    slots(p.decor.footer, 0.5 * PT - 3);
  }
  return ops.join('\n');
}

function writePdf(pages: OutPage[], size: { w: number; h: number }, title: string): string {
  const objs: string[] = [];
  const add = (body: string) => {
    objs.push(body);
    return objs.length;
  };
  const catalog = add('');
  const pagesObj = add('');
  const font = (name: string) => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`);
  const f1 = font('Courier');
  const f2 = font('Courier-Bold');
  const f3 = font('Courier-Oblique');
  const f4 = font('Courier-BoldOblique');
  const f5 = font('Helvetica-Bold');
  const info = add(`<< /Title ${pdfString(title || 'Screenplay')} /Creator (Terra Script) /Producer (Terra Script) >>`);
  const kids: number[] = [];
  for (const p of pages) {
    const stream = pageStream(p, size.h, size.w);
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${num(size.w)} ${num(size.h)}] ` +
          `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R /F4 ${f4} 0 R /F5 ${f5} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  // Everything is 7-bit ASCII, so string length equals byte length.
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** The script laid out on pages exactly as the PDF prints it. */
export function layoutPages(blocks: Block[], opts: LayoutOptions): LaidPage[] {
  const { linesPerPage } = pageGeometry(opts.paper);
  return paginate(buildUnits(blocks, opts), linesPerPage, opts, anchorsOf(blocks, opts));
}

/** Pages of rows (kept for page counts in reports and the project list). */
export function layoutScript(blocks: Block[], opts: LayoutOptions): Row[][] {
  return layoutPages(blocks, opts).map((p) => p.rows);
}

export interface PageStart {
  /** Script block the page starts with. */
  block: number;
  /** Wrapped line inside that block (0 = the block starts the page). */
  line: number;
  /** Printed lines above the first script line (CONTINUED:, NAME (CONT'D)). */
  lead: number;
}

/**
 * Where each page after the first begins, using exactly the PDF pagination,
 * so on-screen page breaks, page counts and the PDF always agree.
 */
export function pageStarts(blocks: Block[], opts: LayoutOptions): { pages: number; starts: PageStart[]; laid: LaidPage[] } {
  const laid = layoutPages(blocks, opts);
  const starts: PageStart[] = [];
  for (const page of laid.slice(1)) {
    const first = page.rows.find((r) => r.src !== undefined);
    if (first) starts.push({ block: first.src!, line: first.line ?? 0, lead: page.lead });
  }
  return { pages: Math.max(1, laid.length), starts, laid };
}

/** First block + wrapped line of every page (what "Lock pages" stores). */
export function pageAnchors(blocks: Block[], opts: LayoutOptions): { block: number; line: number; label: string }[] {
  return layoutPages(blocks, { ...opts, pagesLocked: false })
    .map((p, k) => {
      const first = p.rows.find((r) => r.src !== undefined);
      return first ? { block: first.src!, line: first.line ?? 0, label: String(k + 1) } : null;
    })
    .filter((x): x is { block: number; line: number; label: string } => x !== null);
}

/** Which page (index) every block starts on. */
export function blockPages(laid: LaidPage[]): Map<number, number> {
  const m = new Map<number, number>();
  laid.forEach((p, k) => p.rows.forEach((r) => r.src !== undefined && !m.has(r.src) && m.set(r.src, k)));
  return m;
}

export function buildPdf(blocks: Block[], opts: PdfOptions): Blob {
  const size = PAPER[opts.paper];
  const { linesPerPage } = pageGeometry(opts.paper);
  const pages: OutPage[] = [];
  const tp = opts.titlePage;
  const watermark = opts.watermark?.trim() || undefined;
  if (tp && tp.title.trim()) {
    const centerX = (size.w / 2 - LEFT) / CHAR;
    pages.push({ rows: titleRows(tp, linesPerPage, centerX), watermark });
  }
  if (opts.script !== false) {
    layoutPages(blocks, opts).forEach((p, i) => pages.push({ rows: p.rows, decor: pageDecor(opts, p, i), watermark }));
  }
  if (opts.report?.length) {
    // Report lines are pre-aligned in columns: only wrap the ones that don't fit,
    // since wrapping collapses the spacing.
    const rows: Row[] = opts.report.flatMap((l) =>
      (l.text.length <= WIDTH ? [l.text] : wrap(l.text, WIDTH)).map((text) => [
        {
          x: l.center ? (WIDTH - text.length) / 2 : 0,
          text,
          font: (l.bold ? 'B' : 'R') as Font,
          underline: l.underline,
        },
      ]),
    );
    for (let i = 0; i < rows.length; i += linesPerPage) pages.push({ rows: rows.slice(i, i + linesPerPage) });
  }
  if (!pages.length) pages.push({ rows: [] });
  return new Blob([writePdf(pages, size, tp?.title ?? opts.title ?? '')], { type: 'application/pdf' });
}
