/**
 * Storyboard PDF: landscape pages with a grid of panels. Each scene starts a
 * new row under its heading; every panel shows its drawing, its number, shot
 * details and note. Written without dependencies, like pdf.ts, but with the
 * drawings embedded as JPEG images.
 */
import { pdfString } from './pdf';

export interface PdfPanel {
  label: string;
  /** Shot size · angle · movement · duration. */
  details: string;
  note: string;
  image?: Blob;
}
export interface PdfScene {
  label: string;
  heading: string;
  panels: PdfPanel[];
}
export interface StoryboardPdfOptions {
  title: string;
  /** Word for the page header, e.g. "Storyboard". */
  kind: string;
  paper: 'letter' | 'a4';
  /** Frame width / height. */
  aspect: number;
  /** "Page {n} of {total}" style label maker. */
  pageLabel: (n: number, total: number) => string;
}

const PAGE = { letter: { w: 792, h: 612 }, a4: { w: 842, h: 595 } }; // landscape
const M = 36; // margin
const GAP = 14;
const HEAD_H = 28; // page header band
const SCENE_H = 22; // scene heading row
const NOTE_LINES = 4;
const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

/** Rough Helvetica width, good enough for wrapping captions. */
const textWidth = (s: string, size: number) => s.length * size * 0.5;

function wrap(text: string, size: number, width: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (textWidth(next, size) <= width) line = next;
    else {
      if (line) lines.push(line);
      line = w;
      while (textWidth(line, size) > width) {
        const fitChars = Math.max(1, Math.floor(width / (size * 0.5)));
        lines.push(line.slice(0, fitChars));
        line = line.slice(fitChars);
      }
    }
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    let last = lines[maxLines - 1];
    while (last && textWidth(`${last}…`, size) > width) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last.trimEnd()}…`;
  }
  return lines;
}

/** The drawing as JPEG bytes on white, at most `maxW` px wide. */
async function toJpeg(blob: Blob, maxW: number): Promise<{ bytes: Uint8Array; w: number; h: number } | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, maxW / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * s));
    const h = Math.max(1, Math.round(bmp.height * s));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const jpg = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.86));
    if (!jpg) return null;
    return { bytes: new Uint8Array(await jpg.arrayBuffer()), w, h };
  } catch {
    return null;
  }
}

type Row = { kind: 'scene'; scene: PdfScene } | { kind: 'panels'; panels: PdfPanel[] };

export async function buildStoryboardPdf(scenes: PdfScene[], opts: StoryboardPdfOptions): Promise<Blob> {
  const size = PAGE[opts.paper];
  const cols = opts.aspect < 0.8 ? 5 : opts.aspect < 1.2 ? 4 : 3;
  const innerW = size.w - 2 * M;
  const cellW = (innerW - GAP * (cols - 1)) / cols;
  const frameH = Math.min(cellW / opts.aspect, (size.h - 2 * M - HEAD_H - SCENE_H) * 0.62);
  const frameW = frameH * opts.aspect;
  const captionH = 13 + NOTE_LINES * 10 + 4;
  const cellH = frameH + 6 + captionH;

  // Rows: a heading per scene, then its panels `cols` at a time.
  const rows: Row[] = [];
  for (const s of scenes) {
    if (!s.panels.length) continue;
    rows.push({ kind: 'scene', scene: s });
    for (let i = 0; i < s.panels.length; i += cols) rows.push({ kind: 'panels', panels: s.panels.slice(i, i + cols) });
  }
  // Pages: a scene heading never ends a page on its own.
  const pages: Row[][] = [];
  let page: Row[] = [];
  let y = 0;
  const avail = size.h - 2 * M - HEAD_H;
  rows.forEach((row, i) => {
    const h = row.kind === 'scene' ? SCENE_H : cellH + GAP;
    const needs = row.kind === 'scene' ? SCENE_H + cellH : h;
    if (page.length && y + needs > avail) {
      pages.push(page);
      page = [];
      y = 0;
    }
    // A continued scene repeats its heading at the top of the new page.
    if (!page.length && row.kind === 'panels') {
      for (let j = i - 1; j >= 0; j--) {
        const r = rows[j];
        if (r.kind === 'scene') {
          page.push(r);
          y += SCENE_H;
          break;
        }
      }
    }
    page.push(row);
    y += h;
  });
  if (page.length) pages.push(page);
  if (!pages.length) pages.push([]);

  // Objects. Binary JPEG streams make this a list of byte chunks.
  const objs: (string | Uint8Array)[][] = [];
  const add = (...parts: (string | Uint8Array)[]) => {
    objs.push(parts);
    return objs.length;
  };
  const catalog = add('');
  const pagesObj = add('');
  const fontR = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontB = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const info = add(`<< /Title ${pdfString(`${opts.title} - ${opts.kind}`)} /Creator (Terra Script) /Producer (Terra Script) >>`);

  const images = new Map<PdfPanel, number>();
  for (const s of scenes) {
    for (const p of s.panels) {
      if (!p.image) continue;
      const jpg = await toJpeg(p.image, 900);
      if (!jpg) continue;
      images.set(
        p,
        add(
          `<< /Type /XObject /Subtype /Image /Width ${jpg.w} /Height ${jpg.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.bytes.length} >>\nstream\n`,
          jpg.bytes,
          '\nendstream',
        ),
      );
    }
  }

  const kids: number[] = [];
  pages.forEach((rowsOnPage, pi) => {
    const ops: string[] = [];
    const text = (s: string, x: number, yy: number, sz: number, bold = false, grey = 0) =>
      ops.push(`BT ${grey ? `${fmt(grey)} g ` : '0 g '}/${bold ? 'FB' : 'FR'} ${sz} Tf ${fmt(x)} ${fmt(yy)} Td ${pdfString(s)} Tj ET`);
    const top = size.h - M;
    // Header: title on the left, kind and page on the right, a hairline below.
    text(opts.title, M, top - 12, 12, true);
    const right = `${opts.kind}  ·  ${opts.pageLabel(pi + 1, pages.length)}`;
    text(right, size.w - M - textWidth(right, 9), top - 11, 9, false, 0.4);
    ops.push(`0.8 G 0.5 w ${fmt(M)} ${fmt(top - 20)} m ${fmt(size.w - M)} ${fmt(top - 20)} l S`);

    let cy = top - HEAD_H;
    for (const row of rowsOnPage) {
      if (row.kind === 'scene') {
        const head = `${row.scene.label ? `${row.scene.label}.  ` : ''}${row.scene.heading}`;
        text(wrap(head, 10, innerW, 1)[0] ?? '', M, cy - 14, 10, true);
        cy -= SCENE_H;
        continue;
      }
      row.panels.forEach((p, k) => {
        const x = M + k * (cellW + GAP);
        const fx = x + (cellW - frameW) / 2;
        const fy = cy - frameH;
        const img = images.get(p);
        if (img) ops.push(`q ${fmt(frameW)} 0 0 ${fmt(frameH)} ${fmt(fx)} ${fmt(fy)} cm /Im${img} Do Q`);
        ops.push(`0.25 G 0.75 w ${fmt(fx)} ${fmt(fy)} ${fmt(frameW)} ${fmt(frameH)} re S`);
        let ty = fy - 14;
        text(p.label, fx, ty, 9, true);
        if (p.details) text(wrap(p.details, 8, frameW - textWidth(p.label, 9) - 8, 1)[0] ?? '', fx + textWidth(p.label, 9) + 8, ty, 8, false, 0.35);
        for (const line of wrap(p.note, 8.5, frameW, NOTE_LINES)) {
          ty -= 10;
          text(line, fx, ty, 8.5);
        }
      });
      cy -= cellH + GAP;
    }
    const stream = ops.join('\n');
    const xobjs = rowsOnPage
      .flatMap((r) => (r.kind === 'panels' ? r.panels : []))
      .map((p) => images.get(p))
      .filter((n): n is number => n !== undefined);
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${size.w} ${size.h}] /Resources << /Font << /FR ${fontR} 0 R /FB ${fontB} 0 R >>` +
          `${xobjs.length ? ` /XObject << ${xobjs.map((n) => `/Im${n} ${n} 0 R`).join(' ')} >>` : ''} >> /Contents ${content} 0 R >>`,
      ),
    );
  });
  objs[catalog - 1] = [`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`];
  objs[pagesObj - 1] = [`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`];

  // Serialise. Strings are 7-bit ASCII (pdfString escapes the rest), so their length is their byte count.
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const put = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? enc.encode(part) : part;
    chunks.push(bytes);
    offset += bytes.length;
  };
  put('%PDF-1.4\n');
  const offsets: number[] = [];
  objs.forEach((parts, i) => {
    offsets.push(offset);
    put(`${i + 1} 0 obj\n`);
    for (const p of parts) put(p);
    put('\nendobj\n');
  });
  const xref = offset;
  put(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`);
  for (const o of offsets) put(`${String(o).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
}
