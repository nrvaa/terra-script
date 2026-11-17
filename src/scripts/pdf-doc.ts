/**
 * A small flowing PDF writer for documents like the call sheet: headings,
 * wrapped text, tables with wrapping cells, automatic page breaks and a page
 * footer. Helvetica only (built into every PDF reader), no dependencies.
 */
import { pdfString } from './pdf';

const PAPER = { letter: { w: 612, h: 792 }, a4: { w: 595, h: 842 } };
const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

/** Approximate Helvetica advance widths (per 1pt of font size). */
function charWidth(c: string, bold: boolean): number {
  let w: number;
  if (c === ' ') w = 0.278;
  else if ('iljI.,:;|!\'’`'.includes(c)) w = 0.24;
  else if ('ftr()[]{}-/'.includes(c)) w = 0.34;
  else if ('mwMW'.includes(c)) w = 0.85;
  else if (/[A-Z]/.test(c)) w = 0.68;
  else if (/[0-9]/.test(c)) w = 0.556;
  else w = 0.53;
  return bold ? w * 1.06 : w;
}
export const textWidth = (s: string, size: number, bold = false) => [...s].reduce((n, c) => n + charWidth(c, bold), 0) * size;

export function wrapText(text: string, size: number, width: number, bold = false): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= width || !line) line = next;
      else {
        out.push(line);
        line = word;
      }
      // A single word longer than the column: cut it.
      while (textWidth(line, size, bold) > width && line.length > 1) {
        let k = line.length - 1;
        while (k > 1 && textWidth(line.slice(0, k), size, bold) > width) k--;
        out.push(line.slice(0, k));
        line = line.slice(k);
      }
    }
    out.push(line);
  }
  return out;
}

export interface Cell {
  text: string;
  bold?: boolean;
  grey?: boolean;
  align?: 'left' | 'right' | 'center';
}

export class PdfDoc {
  readonly w: number;
  readonly h: number;
  readonly margin = 40;
  y = 0;
  private pages: string[][] = [];
  private ops: string[] = [];
  constructor(
    paper: 'letter' | 'a4',
    private title: string,
    private footer?: (page: number, total: number) => string,
  ) {
    ({ w: this.w, h: this.h } = PAPER[paper]);
    this.newPage();
  }

  get inner() {
    return this.w - 2 * this.margin;
  }

  newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = this.h - this.margin;
  }

  /** Start a new page when fewer than `h` points are left. */
  ensure(h: number) {
    if (this.y - h < this.margin + 18) this.newPage();
  }

  gap(h: number) {
    this.y -= h;
  }

  textAt(s: string, x: number, y: number, size: number, bold = false, grey = 0) {
    this.ops.push(`BT ${fmt(grey)} g /${bold ? 'FB' : 'FR'} ${size} Tf ${fmt(x)} ${fmt(y)} Td ${pdfString(s)} Tj ET`);
  }

  /** Wrapped text at the cursor. */
  text(s: string, o: { size?: number; bold?: boolean; grey?: number; x?: number; width?: number; leading?: number } = {}) {
    const size = o.size ?? 10;
    const lead = o.leading ?? size * 1.3;
    const x = o.x ?? this.margin;
    for (const line of wrapText(s, size, o.width ?? this.inner - (x - this.margin), o.bold)) {
      this.ensure(lead);
      this.y -= lead;
      this.textAt(line, x, this.y + lead * 0.25, size, o.bold, o.grey ?? 0);
    }
  }

  rule(grey = 0.8, width = 0.6) {
    this.ops.push(`${fmt(grey)} G ${fmt(width)} w ${fmt(this.margin)} ${fmt(this.y)} m ${fmt(this.w - this.margin)} ${fmt(this.y)} l S`);
  }

  rect(x: number, y: number, w: number, h: number, fill: number) {
    this.ops.push(`${fmt(fill)} g ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re f`);
  }

  /** A section title with a line under it. */
  heading(s: string) {
    this.ensure(40);
    this.gap(14);
    this.text(s.toUpperCase(), { size: 9.5, bold: true, grey: 0.25 });
    this.gap(3);
    this.rule(0.55, 0.8);
    this.gap(2);
  }

  /** A table: column widths in points; a column of width 0 takes the rest. */
  table(widths: number[], head: string[], rows: Cell[][], size = 8.5) {
    const total = this.inner;
    // A width of 0 means "the rest of the line".
    const ws = widths.map((w) => w || total - widths.reduce((a, b) => a + b, 0));
    const pad = 4;
    const lead = size * 1.28;
    const drawRow = (cells: Cell[], isHead: boolean) => {
      const wrapped = cells.map((c, i) => wrapText(c.text ?? '', size, ws[i] - 2 * pad, isHead || c.bold));
      const hgt = Math.max(1, ...wrapped.map((l) => l.length)) * lead + 2 * pad - 2;
      if (this.y - hgt < this.margin + 18) {
        this.newPage();
        if (!isHead) drawRow(head.map((text) => ({ text })), true);
      }
      if (isHead) this.rect(this.margin, this.y - hgt, total, hgt, 0.93);
      let x = this.margin;
      cells.forEach((c, i) => {
        wrapped[i].forEach((line, k) => {
          const tw = textWidth(line, size, isHead || c.bold);
          const lx = c.align === 'right' ? x + ws[i] - pad - tw : c.align === 'center' ? x + (ws[i] - tw) / 2 : x + pad;
          this.textAt(line, lx, this.y - pad - (k + 1) * lead + lead * 0.28, size, isHead || c.bold, c.grey ? 0.42 : 0);
        });
        x += ws[i];
      });
      this.y -= hgt;
      this.ops.push(`0.86 G 0.5 w ${fmt(this.margin)} ${fmt(this.y)} m ${fmt(this.margin + total)} ${fmt(this.y)} l S`);
    };
    this.ensure(lead * 3);
    drawRow(head.map((text) => ({ text })), true);
    for (const r of rows) drawRow(r, false);
  }

  build(): Blob {
    const total = this.pages.length;
    const objs: string[] = [];
    const add = (body: string) => objs.push(body);
    add(''); // catalog
    add(''); // pages
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    add(`<< /Title ${pdfString(this.title)} /Creator (Terra Script) /Producer (Terra Script) >>`);
    const kids: number[] = [];
    this.pages.forEach((ops, i) => {
      const foot = this.footer?.(i + 1, total);
      const all = foot ? [...ops, `BT 0.45 g /FR 8 Tf ${fmt(this.w - this.margin - textWidth(foot, 8))} ${fmt(this.margin - 16)} Td ${pdfString(foot)} Tj ET`] : ops;
      const stream = all.join('\n');
      const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.w} ${this.h}] /Resources << /Font << /FR 3 0 R /FB 4 0 R >> >> /Contents ${content} 0 R >>`));
    });
    objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    // pdfString escapes everything outside ASCII, so string length = byte length.
    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    objs.forEach((body, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new Blob([out], { type: 'application/pdf' });
  }
}
