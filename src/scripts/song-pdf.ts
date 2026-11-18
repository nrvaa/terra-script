/**
 * Song sheets as PDF: one song, or a whole album / EP (a cover page with the
 * tracklist, then every song from a new page). Lyrics and chords are set in
 * Courier (every character 0.6 em wide), so a chord lands over the same
 * column it was typed above — exactly like on screen. Titles use Helvetica.
 * Sticky notes are the writer's own and are never printed.
 */
import { pdfString } from './pdf';
import { textWidth } from './pdf-doc';
import { linesOf, metaLine, sectionLabels, type AlbumDoc, type SongDoc } from './song';

const PAPER = { letter: { w: 612, h: 792 }, a4: { w: 595, h: 842 } };
const MARGIN = 54; // 0.75in
const SIZE = 11; // lyrics and chords
const CHAR = SIZE * 0.6;
const LEAD = 13.5;
const ACCENT = '0.416 0.18 0.847'; // Terra purple
const num = (n: number) => (Math.round(n * 100) / 100).toString();

export interface SongPdfOptions {
  chords: boolean;
  paper: 'letter' | 'a4';
  byLabel: string;
  key: string;
  capo: string;
  untitled: string;
  /** Cover art to put on the first page (a square JPEG). */
  cover?: PdfCover;
}

/** A square JPEG, embedded as is (the PDF reader decodes it: DCTDecode). */
export interface PdfCover {
  jpeg: Uint8Array;
  size: number;
}

/** Bytes as hex text, so the file stays plain text and every offset in it stays right. */
function hex(bytes: Uint8Array): string {
  const digits = '0123456789abcdef';
  const out = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = digits[bytes[i] >> 4] + digits[bytes[i] & 15];
  return out.join('');
}

export interface AlbumPdfOptions extends SongPdfOptions {
  albumUntitled: string;
  typeLabel: string;
  tracklistLabel: string;
}

/** Cut a chord + lyric pair into rows that fit, breaking the lyric at a space where possible. */
function fitPair(chords: string, lyric: string, cols: number): [string, string][] {
  const out: [string, string][] = [];
  while (lyric.length > cols || chords.length > cols) {
    let cut = lyric.lastIndexOf(' ', cols);
    if (cut < cols * 0.5) cut = cols;
    out.push([chords.slice(0, cut).trimEnd(), lyric.slice(0, cut).trimEnd()]);
    chords = chords.slice(cut);
    lyric = lyric.slice(cut);
    // The continued lyric starts at column 0: drop the space it was cut at (and the same column of chords).
    if (lyric.startsWith(' ')) {
      lyric = lyric.slice(1);
      chords = chords.slice(1);
    }
  }
  out.push([chords.trimEnd(), lyric]);
  return out;
}

class Writer {
  readonly w: number;
  readonly h: number;
  readonly cols: number;
  pages: string[][] = [];
  ops: string[] = [];
  y = 0;
  constructor(paper: 'letter' | 'a4') {
    ({ w: this.w, h: this.h } = PAPER[paper]);
    this.cols = Math.floor((this.w - 2 * MARGIN) / CHAR);
  }
  newPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = this.h - MARGIN;
  }
  room(need: number) {
    if (this.y - need < MARGIN + 20) this.newPage();
  }
  text(s: string, x: number, font: string, size: number, color = '0 g') {
    this.ops.push(`BT ${color} /${font} ${size} Tf ${num(x)} ${num(this.y)} Td ${pdfString(s)} Tj ET`);
  }
  rule() {
    this.ops.push(`0.8 G 0.6 w ${MARGIN} ${num(this.y)} m ${num(this.w - MARGIN)} ${num(this.y)} l S`);
  }
  cover?: PdfCover;
  /** Draw the cover art with its bottom-left corner at (x, y), `size` points square, with a thin frame. */
  image(x: number, y: number, size: number) {
    if (!this.cover) return;
    this.ops.push(`q ${num(size)} 0 0 ${num(size)} ${num(x)} ${num(y)} cm /Cv Do Q`);
    this.ops.push(`0.85 G 0.5 w ${num(x)} ${num(y)} ${num(size)} ${num(size)} re S`);
  }

  /** One song, starting on a fresh page. */
  song(doc: SongDoc, title: string, o: SongPdfOptions, withCover = false) {
    this.newPage();
    // A single's cover sits in the top-right corner, beside the title.
    const coverSize = 92;
    if (withCover && this.cover) this.image(this.w - MARGIN - coverSize, this.h - MARGIN - coverSize, coverSize);
    this.y -= 20;
    this.text(title, MARGIN, 'HB', 18);
    if (doc.writer.trim()) {
      this.y -= 16;
      this.text(`${o.byLabel} ${doc.writer.trim()}`, MARGIN, 'H', 10.5, '0.35 g');
    }
    const meta = o.chords ? metaLine(doc, o) : '';
    if (meta) {
      this.y -= 14;
      this.text(meta, MARGIN, 'H', 9.5, '0.45 g');
    }
    // Below the cover, whatever the heading's height.
    if (withCover && this.cover) this.y = Math.min(this.y, this.h - MARGIN - coverSize);
    this.y -= 10;
    this.rule();
    const labels = sectionLabels(doc);
    for (const s of doc.sections) {
      const rows = linesOf(doc, s).flatMap((l) => fitPair(o.chords ? l.chords : '', l.lyric, this.cols));
      const pairH = (r: [string, string]) => (r[0].trim() ? LEAD : 0) + (r[1].trim() || !r[0].trim() ? LEAD : 0);
      // Keep a section's label with its first line.
      this.room(26 + (rows[0] ? pairH(rows[0]) : 0));
      this.y -= 22;
      this.text(labels.get(s.id)!.toUpperCase(), MARGIN, 'HB', 9.5, `${ACCENT} rg`);
      this.y -= 4;
      for (const r of rows) {
        // A chord and its lyric always stay on the same page.
        this.room(pairH(r));
        if (r[0].trim()) {
          this.y -= LEAD;
          this.text(r[0], MARGIN, 'CB', SIZE, `${ACCENT} rg`);
        }
        if (r[1].trim() || !r[0].trim()) {
          this.y -= LEAD;
          if (r[1].trim()) this.text(r[1], MARGIN, 'C', SIZE);
        }
      }
    }
  }

  build(title: string): Blob {
    const objs: string[] = ['', ''];
    const add = (body: string) => objs.push(body);
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); // 3
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'); // 4
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'); // 5
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>'); // 6
    add(`<< /Title ${pdfString(title)} /Creator (Terra Script) /Producer (Terra Script) >>`); // 7
    let xobj = '';
    if (this.cover) {
      const data = hex(this.cover.jpeg) + '>';
      const n = add(
        `<< /Type /XObject /Subtype /Image /Width ${this.cover.size} /Height ${this.cover.size} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCIIHexDecode /DCTDecode] /Length ${data.length} >>
stream
${data}
endstream`,
      );
      xobj = ` /XObject << /Cv ${n} 0 R >>`;
    }
    const kids: number[] = [];
    const total = this.pages.length;
    this.pages.forEach((p, i) => {
      const foot = total > 1 ? `${title} · ${i + 1}/${total}` : '';
      const footOps = foot ? [`BT 0.5 g /H 8 Tf ${num(this.w - MARGIN - textWidth(foot, 8))} ${MARGIN - 22} Td ${pdfString(foot)} Tj ET`] : [];
      const stream = [...p, ...footOps].join('\n');
      const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.w} ${this.h}] /Resources << /Font << /H 3 0 R /HB 4 0 R /C 5 0 R /CB 6 0 R >>${xobj} >> /Contents ${content} 0 R >>`));
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
    for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new Blob([out], { type: 'application/pdf' });
  }
}

export function buildSongPdf(doc: SongDoc, o: SongPdfOptions): Blob {
  const w = new Writer(o.paper);
  w.cover = o.cover;
  const title = doc.title.trim() || o.untitled;
  w.song(doc, title, o, true);
  return w.build(title);
}

/** The album as one PDF: a cover page with the tracklist, then each song. */
export function buildAlbumPdf(a: AlbumDoc, o: AlbumPdfOptions): Blob {
  const w = new Writer(o.paper);
  w.cover = o.cover;
  const title = a.title.trim() || o.albumUntitled;
  w.newPage();
  if (w.cover) {
    // The cover art, big, at the top of the cover page.
    const size = 300;
    w.image(MARGIN, w.h - MARGIN - size, size);
    w.y = w.h - MARGIN - size - 34;
  } else w.y -= 150;
  w.text(o.typeLabel.toUpperCase(), MARGIN, 'HB', 10, `${ACCENT} rg`);
  w.y -= 30;
  w.text(title, MARGIN, 'HB', 26);
  const sub = [a.artist.trim(), a.year.trim()].filter(Boolean).join(' · ');
  if (sub) {
    w.y -= 20;
    w.text(sub, MARGIN, 'H', 12, '0.35 g');
  }
  w.y -= 40;
  w.text(o.tracklistLabel.toUpperCase(), MARGIN, 'HB', 9.5, '0.45 g');
  w.y -= 8;
  w.rule();
  a.tracks.forEach((t, i) => {
    w.room(18);
    w.y -= 18;
    w.text(`${i + 1}.`, MARGIN, 'H', 11, '0.45 g');
    w.text(t.title.trim() || o.untitled, MARGIN + 24, 'H', 11);
  });
  a.tracks.forEach((t, i) => w.song(t, `${i + 1}. ${t.title.trim() || o.untitled}`, o));
  return w.build(title);
}
