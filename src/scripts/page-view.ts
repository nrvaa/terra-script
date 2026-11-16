/**
 * Page view: shows the script as separate sheets of paper, broken exactly
 * where the PDF breaks (same pagination engine):
 *  - every page has its 1" top margin, 1" bottom margin and a gap between sheets
 *  - the page number sits in the top-right corner (from page 2, like the PDF)
 *  - dialogue split over two pages shows (MORE) and NAME (CONT'D)
 *
 * How: page-starting blocks get an extra top margin; a page that starts in the
 * middle of a long block gets an invisible spacer (.pg-break) inserted at the
 * exact character where the PDF line begins. All measurements are done in one
 * read pass and one write pass, so it stays fast on long scripts.
 */
import { WRAP_WIDTH, lineStarts, pageGeometry, type LaidPage, type PageDecor, type PageStart } from './pdf';
import { characterName, type Block } from './types';

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const DPI = 96;
const LINE_PX = DPI / 6; // 12pt Courier line
const MARGIN_TOP = DPI; // 1"
const MARGIN_BOTTOM = DPI; // 1"
const GAP = 28; // space between sheets
const CONTINUATION = new Set(['dialogue', 'parenthetical', 'lyrics']);

export interface PageViewInput {
  paper: HTMLElement; // #paper (positioned; blocks' offsetParent)
  editor: HTMLElement; // #editor
  layer: HTMLElement; // sheet layer, absolutely positioned inside #paper
  blocks: Block[];
  starts: PageStart[];
  size: 'letter' | 'a4';
  enabled: boolean;
  /** Laid-out pages (labels, CONTINUED) and their header/footer text. */
  laid?: LaidPage[];
  decor?: PageDecor[];
  watermark?: string;
  moreText?: string;
  contdText?: string;
}

/** Remove all page-view adjustments (margins and spacers). */
function clear(editor: HTMLElement) {
  for (const el of editor.querySelectorAll<HTMLElement>('.el[data-pb]')) {
    el.style.marginTop = '';
    delete el.dataset.pb;
  }
  for (const sp of editor.querySelectorAll<HTMLElement>('.pg-break')) {
    const parent = sp.parentElement;
    sp.remove();
    parent?.normalize(); // merge the text nodes the spacer had split
  }
}

/** Insert a zero-height spacer before character `offset` of a block. */
function insertSpacer(el: HTMLElement, offset: number): HTMLElement {
  const sp = document.createElement('span');
  sp.className = 'pg-break';
  sp.contentEditable = 'false';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let remaining = offset;
  while ((node = walker.nextNode())) {
    const len = (node as Text).length;
    if (remaining <= len) {
      const after = remaining === 0 ? node : (node as Text).splitText(remaining);
      after.parentNode!.insertBefore(sp, after);
      return sp;
    }
    remaining -= len;
  }
  el.appendChild(sp);
  return sp;
}

function speakerBefore(blocks: Block[], index: number): string {
  for (let i = index; i >= 0; i--) {
    if (blocks[i].type === 'character') return characterName(blocks[i].text);
    if (!CONTINUATION.has(blocks[i].type)) break;
  }
  return '';
}

export function applyPageView(input: PageViewInput): void {
  const { paper, editor, layer, blocks, starts, size, enabled } = input;
  clear(editor);
  if (!enabled) {
    paper.classList.remove('paged');
    paper.style.minHeight = '';
    layer.innerHTML = '';
    return;
  }
  paper.classList.add('paged');
  const els = editor.children;
  const pageH = pageGeometry(size).heightIn * DPI;

  // 1) Build the break points (write phase: spacers start at height 0).
  type Brk = { el: HTMLElement; spacer?: HTMLElement; contd: boolean; lead: number };
  const breaks: Brk[] = [];
  for (const s of starts) {
    const el = els[s.block] as HTMLElement | undefined;
    const b = blocks[s.block];
    if (!el || !b) continue;
    const contd = CONTINUATION.has(b.type);
    if (s.line === 0 && !contd) {
      el.dataset.pb = '1';
      breaks.push({ el, contd, lead: s.lead });
      continue;
    }
    // Page starts inside a block, or continues a speech: break at the PDF line.
    const width = WRAP_WIDTH[b.type] ?? 60;
    let offset = s.line > 0 ? (lineStarts(b.text, width)[s.line] ?? 0) : 0;
    if (b.type === 'parenthetical' && s.line > 0 && !b.text.trim().startsWith('(')) offset = Math.max(0, offset - 1);
    const spacer = insertSpacer(el, offset);
    if (contd && s.line === 0 && s.lead === 0) {
      // Speech moved whole to the next page (MORE/CONT'D switched off).
      breaks.push({ el, spacer, contd: false, lead: 0 });
      continue;
    }
    if (contd) {
      const name = speakerBefore(blocks, s.block);
      const word = (input.contdText || "CONT'D").trim();
      spacer.dataset.more = `(${(input.moreText || 'MORE').trim()})`;
      spacer.dataset.contd = name ? `${name} (${word})` : `(${word})`;
      spacer.dataset.type = b.type;
    }
    breaks.push({ el, spacer, contd, lead: s.lead });
  }

  // 2) Read phase: natural positions (one layout).
  const natural = breaks.map((br) => ({
    top: br.spacer ? br.el.offsetTop + br.spacer.offsetTop : br.el.offsetTop,
    margin: br.spacer ? 0 : parseFloat(getComputedStyle(br.el).marginTop) || 0,
  }));
  const last = els[els.length - 1] as HTMLElement | undefined;
  const contentBottom = last ? last.offsetTop + last.offsetHeight : MARGIN_TOP;

  // 3) Write phase: push each page start to the top margin of its sheet.
  const sheetTops = [0];
  let shift = 0;
  breaks.forEach((br, k) => {
    const prevSheet = sheetTops[k];
    // Lines printed above the first script line (CONTINUED:, NAME (CONT'D)).
    const lead = br.lead * LINE_PX;
    const target = prevSheet + pageH + GAP + MARGIN_TOP + lead;
    const actual = natural[k].top + shift;
    const delta = Math.max(0, target - actual);
    if (br.spacer) br.spacer.style.height = `${delta}px`;
    else br.el.style.marginTop = `${natural[k].margin + delta}px`;
    shift += delta;
    // If the screen text ran long (rare), the sheet grows instead of overlapping.
    sheetTops.push(actual + delta - MARGIN_TOP - lead);
  });

  const lastTop = sheetTops[sheetTops.length - 1];
  const lastHeight = Math.max(pageH, contentBottom + shift + MARGIN_BOTTOM - lastTop);
  paper.style.minHeight = `${lastTop + lastHeight}px`;

  // 4) Sheets with header / footer (page number), CONTINUED and the watermark.
  const lpp = pageGeometry(size).linesPerPage;
  const slot = (cls: string, texts: string[] | undefined) =>
    texts?.some(Boolean)
      ? `<div class="${cls}">${texts.map((s, i) => `<span class="${['l', 'c', 'r'][i]}">${escHtml(s)}</span>`).join('')}</div>`
      : '';
  const wm = input.watermark?.trim() ? `<span class="sheet-wm">${escHtml(input.watermark.trim())}</span>` : '';
  layer.innerHTML = sheetTops
    .map((top, k) => {
      const height = k < sheetTops.length - 1 ? sheetTops[k + 1] - GAP - top : lastHeight;
      const d = input.decor?.[k];
      const page = input.laid?.[k];
      const next = input.laid?.[k + 1];
      const label = d ? '' : k ? `<div class="sheet-hdr"><span class="r">${escHtml(page?.label ?? String(k + 1))}.</span></div>` : '';
      const contTop = page?.continued ? `<span class="sheet-cont" style="top:${MARGIN_TOP}px">CONTINUED:</span>` : '';
      const contBottom = next?.continued ? `<span class="sheet-cont r" style="top:${MARGIN_TOP + (lpp - 1) * LINE_PX}px">(CONTINUED)</span>` : '';
      return `<div class="sheet" style="top:${top}px;height:${height}px">${wm}${label}${slot('sheet-hdr', d?.header)}${slot('sheet-ftr', d?.footer)}${contTop}${contBottom}</div>`;
    })
    .join('');
}
