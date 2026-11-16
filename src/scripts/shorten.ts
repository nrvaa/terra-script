/**
 * Shorten document: find paragraphs whose last printed line holds only a word
 * or two. Trimming those few characters saves a whole line each — the classic
 * way to bring a script's page count down without cutting content.
 */
import { WRAP_WIDTH, lineStarts } from './pdf';
import type { Block } from './types';

export interface TightSpot {
  block: number;
  /** Characters on the last line (trim this many to save a line). */
  chars: number;
  /** Where the last line starts in the block's text. */
  from: number;
  lines: number;
}

const WIDTHS: Record<string, number> = { ...WRAP_WIDTH, action: 60, scene: 60, shot: 60, text: 60 };
const SKIP = new Set(['note', 'section', 'character', 'act', 'endact']);

export function findTightSpots(blocks: Block[], maxChars = 12): TightSpot[] {
  const out: TightSpot[] = [];
  blocks.forEach((b, i) => {
    if (SKIP.has(b.type) || !b.text.trim()) return;
    const width = WIDTHS[b.type] ?? 60;
    const starts = lineStarts(b.text, width);
    if (starts.length < 2) return;
    const from = starts[starts.length - 1];
    const chars = b.text.slice(from).trimEnd().length;
    if (chars > 0 && chars <= maxChars) out.push({ block: i, chars, from, lines: starts.length });
  });
  return out.sort((a, b) => a.chars - b.chars || a.block - b.block);
}
