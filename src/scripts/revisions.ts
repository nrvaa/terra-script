/**
 * Revision tracking: the current script is compared, element by element,
 * with the baseline saved when tracking started (or with an older snapshot).
 */
import type { Block, ElType } from './types';

export type Line = { type: ElType; text: string };

export interface Hunk {
  /** Range in the baseline [aStart, aEnd) replaced by [bStart, bEnd) in the current script. */
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

const key = (l: Line) => `${l.type}\u0000${l.text.trim()}`;

/**
 * Myers diff on element keys. Returns the changed regions only.
 * Common head/tail are trimmed first, so typical edits are very fast.
 */
export function diffLines(a: Line[], b: Line[]): Hunk[] {
  const ka = a.map(key);
  const kb = b.map(key);
  let head = 0;
  while (head < ka.length && head < kb.length && ka[head] === kb[head]) head++;
  let tail = 0;
  while (tail < ka.length - head && tail < kb.length - head && ka[ka.length - 1 - tail] === kb[kb.length - 1 - tail]) tail++;
  const A = ka.slice(head, ka.length - tail);
  const B = kb.slice(head, kb.length - tail);
  if (!A.length && !B.length) return [];
  if (!A.length || !B.length || A.length * B.length > 4e6) {
    // Nothing in common to align (or too big to align cheaply): one hunk.
    return [{ aStart: head, aEnd: head + A.length, bStart: head, bEnd: head + B.length }];
  }

  // Myers O((N+M)D) with a trace for the backtrack.
  const n = A.length;
  const m = B.length;
  const max = n + m;
  const off = max;
  let v: Int32Array = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice());
        break outer;
      }
    }
  }
  // Backtrack into equal pairs.
  const pairs: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const px = v[off + prevK];
    const py = px - prevK;
    while (x > px && y > py) {
      pairs.push([x - 1, y - 1]);
      x--;
      y--;
    }
    x = px;
    y = py;
  }
  while (x > 0 && y > 0 && A[x - 1] === B[y - 1]) {
    pairs.push([x - 1, y - 1]);
    x--;
    y--;
  }
  pairs.reverse();

  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;
  for (const [pa, pb] of [...pairs, [n, m] as [number, number]]) {
    if (pa > ai || pb > bi) hunks.push({ aStart: head + ai, aEnd: head + pa, bStart: head + bi, bEnd: head + pb });
    ai = pa + 1;
    bi = pb + 1;
  }
  return hunks;
}

export const toLines = (blocks: Block[]): Line[] => blocks.map((b) => ({ type: b.type, text: b.text }));

/** Current-script block indices that differ from the baseline, plus where text was deleted. */
export function changedBlocks(baseline: Line[], blocks: Block[]): { changed: Set<number>; deletedBefore: Set<number>; hunks: Hunk[] } {
  const hunks = diffLines(baseline, toLines(blocks));
  const changed = new Set<number>();
  const deletedBefore = new Set<number>();
  for (const h of hunks) {
    for (let i = h.bStart; i < h.bEnd; i++) changed.add(i);
    if (h.bStart === h.bEnd) deletedBefore.add(h.bStart);
  }
  return { changed, deletedBefore, hunks };
}

/** Accept a change: the baseline takes the current text of that hunk. */
export function acceptHunk(baseline: Line[], blocks: Block[], h: Hunk): Line[] {
  return [...baseline.slice(0, h.aStart), ...toLines(blocks.slice(h.bStart, h.bEnd)), ...baseline.slice(h.aEnd)];
}

/** Reject a change: the script gets the baseline text back for that hunk. */
export function rejectHunk(baseline: Line[], blocks: Block[], h: Hunk): Block[] {
  const restored: Block[] = baseline.slice(h.aStart, h.aEnd).map((l, k) => {
    // Keep extra data (synopsis, takes…) of a block that was only retyped.
    const same = blocks[h.bStart + k];
    return same && same.type === l.type ? { ...same, text: l.text, fmt: undefined } : { type: l.type, text: l.text };
  });
  return [...blocks.slice(0, h.bStart), ...restored, ...blocks.slice(h.bEnd)];
}

/**
 * Where a current block was in an older version: the matching index there,
 * or null when it is new. Lets "line history" follow a line through edits.
 */
export function counterpart(old: Line[], blocks: Block[], index: number): number | null {
  const hunks = diffLines(old, toLines(blocks));
  let shift = 0;
  for (const h of hunks) {
    if (index < h.bStart) break;
    if (index < h.bEnd) {
      // Changed line: pair it with the old line at the same position in the hunk.
      const k = index - h.bStart;
      return h.aStart + k < h.aEnd ? h.aStart + k : null;
    }
    shift = h.aEnd - h.bEnd;
  }
  return index + shift;
}
