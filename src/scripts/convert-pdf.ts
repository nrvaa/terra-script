/**
 * Read a screenplay PDF back into Terra Script blocks.
 *
 * A PDF has no idea what a "character" or a "scene" is: it only has text at
 * positions. Screenplays are laid out on a strict grid though, so the type of
 * each line can be told from how far it is indented from the action margin:
 *
 *   action / scene heading   0"
 *   dialogue                 ~1.0"
 *   parenthetical            ~1.5"
 *   character                ~2.0–2.2"
 *   transition               ~4.0" or right-aligned
 *
 * Page furniture is dropped (page numbers, scene numbers, CONTINUED, (MORE),
 * revision asterisks) and speeches split over a page break are joined again.
 * Scanned PDFs (pictures of pages) have no text and can't be read this way.
 */
import { normalizeTitlePage } from './fountain';
import { SCENE_PREFIX, type Block, type ElType, type ScriptDoc, type TitlePage } from './types';

interface Item {
  s: string;
  x: number;
  y: number;
  w: number;
}
interface Line {
  text: string;
  x: number;
  end: number;
  y: number;
  page: number;
  pageW: number;
  pageH: number;
}

const IN = 72;
const TRANSITION = /^((FADE|CUT|DISSOLVE|SMASH CUT|MATCH CUT|JUMP CUT|WIPE|IRIS)\b.*|.+ TO:)$/;
const CONTD = /\s*\((CONT['’]?D|CONTINUED|CONT\.?)\)\s*$/i;
const FURNITURE = [/^\(?MORE\)?$/i, /^\(?CONTINUED\)?:?$/i, /^CONT(INUED|['’]D):?$/i, /^\d+[A-Z]{0,2}\.?$/, /^\*+$/];
const isUpper = (s: string) => /[A-Z]/.test(s) && s === s.toUpperCase();

export class PdfNoTextError extends Error {
  name = 'PdfNoTextError';
}

/** Text lines of every page, top to bottom, with their left edge. */
async function readLines(data: ArrayBuffer): Promise<Line[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(data), isEvalSupported: false }).promise;
  const lines: Line[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const { width: pageW, height: pageH } = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items: Item[] = [];
    for (const it of content.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      items.push({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width });
    }
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    // Items on (nearly) the same baseline form one line.
    const rows: Item[][] = [];
    for (const it of items) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(row[0].y - it.y) <= 2.5) row.push(it);
      else rows.push([it]);
    }
    for (const row of rows) {
      row.sort((a, b) => a.x - b.x);
      // Scene numbers in the margins and revision asterisks are not part of the text.
      while (row.length > 1 && /^(\d+[A-Z]{0,2}\.?|\*+)$/.test(row[0].s.trim())) row.shift();
      while (row.length > 1 && /^(\d+[A-Z]{0,2}\.?|\*+)$/.test(row[row.length - 1].s.trim())) row.pop();
      let text = '';
      let end = row[0].x;
      for (const it of row) {
        if (text && it.x > end + 1.5 && !text.endsWith(' ') && !it.s.startsWith(' ')) text += ' ';
        text += it.s;
        end = Math.max(end, it.x + it.w);
      }
      lines.push({ text: text.replace(/\s+/g, ' ').trim(), x: row[0].x, end, y: row[0].y, page: p, pageW, pageH });
    }
  }
  if (!lines.length) throw new PdfNoTextError('no text');
  return lines;
}

/** The action margin: where scene headings (or most full-width lines) start. */
function actionMargin(lines: Line[]): number {
  const count = new Map<number, number>();
  const scenes = lines.filter((l) => SCENE_PREFIX.test(l.text + ' '));
  for (const l of scenes.length >= 2 ? scenes : lines) {
    const x = Math.round(l.x / 4) * 4;
    count.set(x, (count.get(x) ?? 0) + 1);
  }
  const common = [...count.entries()].filter(([, n]) => n >= Math.min(3, Math.max(1, lines.length / 20)));
  return common.length ? Math.min(...common.map(([x]) => x)) : Math.min(...lines.map((l) => l.x));
}

/** A first page with no scenes and no speeches is a title page. */
function readTitlePage(page: Line[]): Partial<TitlePage> {
  const tp: Partial<TitlePage> = {};
  const centred = (l: Line) => Math.abs((l.x + l.end) / 2 - l.pageW / 2) < 0.6 * IN;
  const top = page.filter((l) => centred(l) && l.y > l.pageH * 0.35);
  const bottom = page.filter((l) => l.y <= l.pageH * 0.35);
  const credit = top.findIndex((l) => /^(written|screenplay|teleplay|story|by\b|ditulis|oleh\b|skenario)/i.test(l.text));
  const titleLines = (credit >= 0 ? top.slice(0, credit) : top.slice(0, 1)).map((l) => l.text);
  if (titleLines.length) tp.title = titleLines.join(' ');
  if (credit >= 0) {
    tp.credit = top[credit].text;
    const rest = top.slice(credit + 1);
    const source = rest.findIndex((l) => /^(based on|berdasarkan|adapted)/i.test(l.text));
    tp.author = (source >= 0 ? rest.slice(0, source) : rest).map((l) => l.text).join(', ');
    if (source >= 0) tp.source = rest.slice(source).map((l) => l.text).join(' ');
  }
  const date = bottom.find((l) => /draft|\b\d{4}\b|\d{1,2}[/.-]\d{1,2}/i.test(l.text) && l.x > l.pageW / 2);
  if (date) tp.draftDate = date.text;
  const contact = bottom.filter((l) => l !== date && l.x < l.pageW / 2);
  if (contact.length) tp.contact = contact.map((l) => l.text).join('\n');
  return tp;
}

/** Fold continuation lines of a paragraph and group speech parts. */
export function linesToBlocks(all: Line[]): { titlePage: Partial<TitlePage>; blocks: Block[] } {
  // Header and footer bands: page numbers, revision labels.
  let lines = all.filter((l) => l.y < l.pageH - 0.72 * IN && l.y > 0.6 * IN);
  let titlePage: Partial<TitlePage> = {};
  const first = lines.filter((l) => l.page === 1);
  const pages = Math.max(...lines.map((l) => l.page));
  if (pages > 1 && first.length && !first.some((l) => SCENE_PREFIX.test(l.text + ' '))) {
    const base0 = actionMargin(lines.filter((l) => l.page > 1));
    const speechy = first.filter((l) => l.x - base0 > 1.8 * IN && l.x - base0 < 2.6 * IN && isUpper(l.text)).length;
    if (speechy < 2) {
      titlePage = readTitlePage(all.filter((l) => l.page === 1));
      lines = lines.filter((l) => l.page > 1);
    }
  }
  const base = actionMargin(lines);
  const right = base + 6 * IN;

  const blocks: Block[] = [];
  let prev: Line | null = null;
  let last: Block | null = null;
  let inSpeech = false;
  let openParen = false;
  /** A speech broke over a page with (MORE): the next NAME (CONT'D) continues it. */
  let moreAt: string | null = null;
  let lastSpeaker = '';

  const add = (type: ElType, text: string) => {
    last = { type, text };
    blocks.push(last);
  };

  for (const l of lines) {
    const text = l.text;
    const off = (l.x - base) / IN;
    const gap = prev ? (prev.page === l.page ? prev.y - l.y : Infinity) : Infinity;
    const newPara = gap > 18; // one blank line or more (12pt lines)
    prev = l;

    if (FURNITURE.some((re) => re.test(text))) {
      if (/^\(?MORE\)?$/i.test(text)) moreAt = lastSpeaker;
      continue;
    }

    // Character cue.
    if (off > 1.75 && off < 3.3 && isUpper(text) && !TRANSITION.test(text) && text.length < 50) {
      const name = text.replace(CONTD, '').trim();
      if (moreAt && name === moreAt && CONTD.test(text)) {
        // Same speech, carried over the page break.
        moreAt = null;
        inSpeech = true;
        continue;
      }
      moreAt = null;
      add('character', name);
      lastSpeaker = name;
      inSpeech = true;
      openParen = false;
      continue;
    }
    // Transition: far right, or a capitalised "… TO:" line.
    if (isUpper(text) && (off >= 3.3 || l.end > right - 0.3 * IN) && (off > 0.5 || TRANSITION.test(text))) {
      add('transition', text);
      inSpeech = false;
      continue;
    }
    // Inside a speech: parentheticals and dialogue.
    if (inSpeech && off > 0.5 && off < 3.3) {
      if (text.startsWith('(') || (openParen && !newPara)) {
        if (openParen && last && (last as Block).type === 'parenthetical') (last as Block).text += ` ${text}`;
        else add('parenthetical', text);
        openParen = !text.endsWith(')');
        continue;
      }
      openParen = false;
      // Lines of one speech (also across a page break) are one dialogue block.
      if (last && (last as Block).type === 'dialogue') (last as Block).text += ` ${text}`;
      else add('dialogue', text);
      continue;
    }
    // Back at the action margin.
    inSpeech = false;
    openParen = false;
    moreAt = null;
    if (SCENE_PREFIX.test(text + ' ') && isUpper(text)) {
      add('scene', text);
      continue;
    }
    // FADE IN: at the action margin stays action, as in Fountain and this app.
    const centred = Math.abs((l.x + l.end) / 2 - (base + 3 * IN)) < 0.4 * IN && off > 0.8;
    if (!newPara && last && ((last as Block).type === 'action' || (last as Block).type === 'text') && !centred) (last as Block).text += ` ${text}`;
    else add(centred ? 'text' : 'action', text);
  }

  // A "character" with no speech after it was really a centred line (THE END).
  blocks.forEach((b, i) => {
    const next = blocks[i + 1]?.type;
    if (b.type === 'character' && next !== 'dialogue' && next !== 'parenthetical') b.type = 'text';
  });
  return { titlePage, blocks };
}

export async function pdfToDoc(file: File): Promise<ScriptDoc> {
  const lines = await readLines(await file.arrayBuffer());
  const { titlePage, blocks } = linesToBlocks(lines);
  if (!blocks.length) throw new PdfNoTextError('no script');
  if (!titlePage.title) titlePage.title = file.name.replace(/\.[^.]+$/, '');
  return { version: 1, titlePage: normalizeTitlePage(titlePage), blocks };
}
