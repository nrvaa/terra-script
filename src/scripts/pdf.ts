/**
 * Screenplay PDF export without dependencies: lays the script out on a
 * Courier 12pt grid (10 characters per inch, 6 lines per inch), paginates it
 * with screenplay rules and writes a PDF using the built-in Courier fonts.
 */
import type { ReportLine } from './report';
import type { Block, TitlePage } from './types';

type Font = 'R' | 'B' | 'I';
interface Seg {
  x: number; // in characters from the left margin (may be fractional/negative)
  text: string;
  font?: Font;
  underline?: boolean;
}
/** A printed line. src/line: which script block (and which wrapped line of it) it came from. */
type Row = Seg[] & { src?: number; line?: number };

/** Mark rows with the block they belong to (used to show the same page breaks on screen). */
function tag(rows: Row[], src: number): Row[] {
  rows.forEach((r, k) => {
    r.src = src;
    r.line = k;
  });
  return rows;
}

export interface PdfOptions {
  paper: 'letter' | 'a4';
  sceneNumbers: boolean;
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
 * Character offset where each wrapped line of `text` starts — the exact same
 * rules as wrap(), so the screen can break a block where the PDF does.
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

const up = (s: string) => s.toUpperCase();

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
}

function dialogueRows(group: Block[], charX: number, offset: number, width: number, idx: number[] = []): { rows: Row[]; paren: Set<number> } {
  const rows: Row[] = [];
  const paren = new Set<number>();
  group.forEach((b, gi) => {
    const first = rows.length;
    if (b.type === 'character') {
      rows.push([{ x: offset + charX, text: up(b.text.trim()) }]);
    } else if (b.type === 'parenthetical') {
      let t = b.text.trim();
      if (t && !t.startsWith('(')) t = `(${t})`;
      const pw = Math.max(10, width - 10);
      wrap(t, pw).forEach((l, i) => {
        paren.add(rows.length);
        rows.push([{ x: offset + 5 + (i ? 1 : 0), text: l }]);
      });
    } else {
      const font: Font = b.type === 'lyrics' ? 'I' : 'R';
      for (const l of wrap(b.text.trim(), width)) rows.push([{ x: offset, text: l, font }]);
    }
    if (idx[gi] !== undefined) tag(rows.slice(first), idx[gi]);
  });
  return { rows, paren };
}

function buildUnits(blocks: Block[], sceneNumbers: boolean): Unit[] {
  const units: Unit[] = [];
  // Keep each block's original index so rows can point back to it.
  const kept = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.type !== 'note' && b.type !== 'section');
  const src = kept.map((k) => k.b);
  const at = kept.map((k) => k.i);
  let scene = 0;

  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    const t = b.text.trim();

    if (b.type === 'character') {
      const group: Block[] = [b];
      const gidx = [at[i]];
      while (i + 1 < src.length && ['parenthetical', 'dialogue', 'lyrics'].includes(src[i + 1].type)) {
        group.push(src[++i]);
        gidx.push(at[i]);
      }
      const prev = units[units.length - 1];
      if (b.dual && prev?.kind === 'dialogue' && (prev as Unit & { group?: Block[] }).group) {
        // Re-lay the previous speech and this one side by side.
        const p = prev as Unit & { group: Block[]; gidx: number[] };
        const left = dialogueRows(p.group, 8, 0, 28, p.gidx);
        const right = dialogueRows(group, 8, 31, 28, gidx);
        const rows: Row[] = [];
        for (let r = 0; r < Math.max(left.rows.length, right.rows.length); r++) {
          const row: Row = [...(left.rows[r] ?? []), ...(right.rows[r] ?? [])];
          const from = left.rows[r] ?? right.rows[r];
          row.src = from?.src;
          row.line = from?.line;
          rows.push(row);
        }
        units[units.length - 1] = { kind: 'dual', before: 1, rows };
        continue;
      }
      const { rows, paren } = dialogueRows(group, 10, 10, 35, gidx);
      units.push({ kind: 'dialogue', before: 1, rows, parenRows: paren, speaker: up(t), group, gidx } as Unit);
      continue;
    }

    switch (b.type) {
      case 'scene': {
        scene++;
        const lines = wrap(up(t), WIDTH);
        const rows: Row[] = lines.map((l) => [{ x: 0, text: l, font: 'B' as Font }]);
        if (sceneNumbers) {
          rows[0].unshift({ x: -7.5, text: String(scene), font: 'B' });
          rows[0].push({ x: WIDTH + 1.5, text: String(scene), font: 'B' });
        }
        units.push({ kind: 'scene', before: 2, rows });
        break;
      }
      case 'transition':
        units.push({ kind: 'plain', before: 1, rows: wrap(up(t), 25).map((l) => [{ x: WIDTH - l.length, text: l }]) });
        break;
      case 'text':
        units.push({ kind: 'plain', before: 1, rows: wrap(t, WIDTH).map((l) => [{ x: (WIDTH - l.length) / 2, text: l }]) });
        break;
      case 'act':
      case 'endact':
        units.push({
          kind: b.type === 'act' ? 'act' : 'plain',
          before: 2,
          rows: wrap(up(t), WIDTH).map((l) => [{ x: (WIDTH - l.length) / 2, text: l, font: 'B' as Font, underline: true }]),
        });
        break;
      case 'shot':
        units.push({ kind: 'plain', before: 1, rows: wrap(up(t), WIDTH).map((l) => [{ x: 0, text: l }]) });
        break;
      case 'parenthetical':
      case 'dialogue':
      case 'lyrics': {
        // Orphaned dialogue part (no character before it).
        const { rows } = dialogueRows([b], 10, 10, 35, [at[i]]);
        units.push({ kind: 'plain', before: 0, rows });
        break;
      }
      default:
        units.push({ kind: 'plain', before: 1, rows: wrap(b.text, WIDTH).map((l) => [{ x: 0, text: l }]) });
    }
    const last = units[units.length - 1];
    if (last && last.rows[0]?.src === undefined) tag(last.rows, at[i]);
  }
  return units;
}

/* ------------------------------------------------------------------ */
/* Pagination                                                          */
/* ------------------------------------------------------------------ */

function paginate(units: Unit[], linesPerPage: number): Row[][] {
  const pages: Row[][] = [[]];
  let page = pages[0];
  const room = () => linesPerPage - page.length;
  const newPage = () => {
    page = [];
    pages.push(page);
  };
  const put = (rows: Row[], before: number) => {
    if (page.length) for (let k = 0; k < before; k++) page.push([]);
    for (const r of rows) {
      if (room() <= 0) newPage();
      page.push(r);
    }
  };
  const need = (u: Unit) => (page.length ? u.before : 0) + u.rows.length;

  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.kind === 'act' && page.length) newPage();

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

    if (u.kind === 'dialogue') {
      let rows = u.rows;
      let before = u.before;
      let shift = 0; // how many body rows earlier pages already consumed
      const name = u.speaker ?? '';
      const contd = /CONT'D/.test(name) ? name : `${name} (CONT'D)`;
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
        put([rows[0], ...rows.slice(1, 1 + fit), [{ x: 20, text: '(MORE)' }]], before);
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
  return pages;
}

/* ------------------------------------------------------------------ */
/* Title page                                                          */
/* ------------------------------------------------------------------ */

function titleRows(tp: TitlePage, linesPerPage: number, centerX: number): Row[] {
  const rows: Row[] = Array.from({ length: linesPerPage }, () => []);
  const center = (s: string, font?: Font, underline?: boolean): Seg => ({ x: centerX - s.length / 2, text: s, font, underline });
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

const FONT_NAME: Record<Font, string> = { R: 'F1', B: 'F2', I: 'F3' };
const num = (n: number) => (Math.round(n * 100) / 100).toString();

function pageStream(rows: Row[], pageH: number, pageW: number, pageNo: number | null): string {
  const ops: string[] = [];
  const baseline = (r: number) => pageH - TOP - r * LINE - 9;
  rows.forEach((row, r) => {
    for (const seg of row) {
      if (!seg.text) continue;
      const x = LEFT + seg.x * CHAR;
      const y = baseline(r);
      ops.push(`BT /${FONT_NAME[seg.font ?? 'R']} 12 Tf ${num(x)} ${num(y)} Td ${pdfString(seg.text)} Tj ET`);
      if (seg.underline) ops.push(`0.6 w ${num(x)} ${num(y - 1.6)} m ${num(x + seg.text.length * CHAR)} ${num(y - 1.6)} l S`);
    }
  });
  if (pageNo !== null) {
    const label = `${pageNo}.`;
    ops.push(`BT /F1 12 Tf ${num(pageW - PT - label.length * CHAR)} ${num(pageH - 0.5 * PT - 9)} Td ${pdfString(label)} Tj ET`);
  }
  return ops.join('\n');
}

function writePdf(pages: { rows: Row[]; pageNo: number | null }[], size: { w: number; h: number }, title: string): string {
  const objs: string[] = [];
  const add = (body: string) => {
    objs.push(body);
    return objs.length;
  };
  const catalog = add('');
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>');
  const f3 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Oblique /Encoding /WinAnsiEncoding >>');
  const info = add(`<< /Title ${pdfString(title || 'Screenplay')} /Creator (Terra Script) /Producer (Terra Script) >>`);
  const kids: number[] = [];
  for (const p of pages) {
    const stream = pageStream(p.rows, size.h, size.w, p.pageNo);
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${num(size.w)} ${num(size.h)}] ` +
          `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >> /Contents ${content} 0 R >>`,
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

export function layoutScript(blocks: Block[], opts: Pick<PdfOptions, 'paper' | 'sceneNumbers'>): Row[][] {
  const size = PAPER[opts.paper];
  const linesPerPage = Math.floor((size.h - TOP - BOTTOM) / LINE);
  return paginate(buildUnits(blocks, opts.sceneNumbers), linesPerPage);
}

export interface PageStart {
  /** Script block the page starts with. */
  block: number;
  /** Wrapped line inside that block (0 = the block starts the page). */
  line: number;
}

/**
 * Where each page after the first begins, using exactly the PDF pagination,
 * so on-screen page breaks, page counts and the PDF always agree.
 */
export function pageStarts(blocks: Block[], opts: Pick<PdfOptions, 'paper' | 'sceneNumbers'>): { pages: number; starts: PageStart[] } {
  const pages = layoutScript(blocks, opts);
  const starts: PageStart[] = [];
  for (const page of pages.slice(1)) {
    const first = page.find((r) => r.src !== undefined);
    if (first) starts.push({ block: first.src!, line: first.line ?? 0 });
  }
  return { pages: Math.max(1, pages.length), starts };
}

export function buildPdf(blocks: Block[], opts: PdfOptions): Blob {
  const size = PAPER[opts.paper];
  const linesPerPage = Math.floor((size.h - TOP - BOTTOM) / LINE);
  const scriptPages = paginate(buildUnits(blocks, opts.sceneNumbers), linesPerPage);
  const pages: { rows: Row[]; pageNo: number | null }[] = [];
  const tp = opts.titlePage;
  if (tp && tp.title.trim()) {
    const centerX = (size.w / 2 - LEFT) / CHAR;
    pages.push({ rows: titleRows(tp, linesPerPage, centerX), pageNo: null });
  }
  // Industry convention: page 1 carries no number; the title page is not counted.
  if (opts.script !== false) scriptPages.forEach((rows, i) => pages.push({ rows, pageNo: i === 0 ? null : i + 1 }));
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
    for (let i = 0; i < rows.length; i += linesPerPage) pages.push({ rows: rows.slice(i, i + linesPerPage), pageNo: null });
  }
  if (!pages.length) pages.push({ rows: [], pageNo: null });
  return new Blob([writePdf(pages, size, tp?.title ?? '')], { type: 'application/pdf' });
}
