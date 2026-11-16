/**
 * Inline formatting (bold / italic / underline / strikethrough).
 * A block keeps plain `text` plus `fmt` runs [start, end, flags]; in the
 * editor the runs are <b>/<i>/<u>/<s> elements inside the block.
 */
import type { Run } from './types';

export type Flag = 'b' | 'i' | 'u' | 's';
export const FLAGS: Flag[] = ['b', 'i', 'u', 's'];
const TAG: Record<Flag, string> = { b: 'B', i: 'I', u: 'U', s: 'S' };

const sortFlags = (f: string) => FLAGS.filter((x) => f.includes(x)).join('');

/** One flags string per character. */
export function expand(len: number, fmt: Run[] | undefined): string[] {
  const out = new Array<string>(len).fill('');
  for (const [s, e, f] of fmt ?? []) for (let k = Math.max(0, s); k < Math.min(len, e); k++) out[k] = sortFlags(out[k] + f);
  return out;
}

/** Per-character flags back to compact runs (undefined when there is no formatting). */
export function compress(chars: string[]): Run[] | undefined {
  const runs: Run[] = [];
  let k = 0;
  while (k < chars.length) {
    const f = chars[k];
    let e = k + 1;
    while (e < chars.length && chars[e] === f) e++;
    if (f) runs.push([k, e, f]);
    k = e;
  }
  return runs.length ? runs : undefined;
}

export function sliceRuns(fmt: Run[] | undefined, start: number, end: number): Run[] | undefined {
  if (!fmt?.length) return undefined;
  const out: Run[] = [];
  for (const [s, e, f] of fmt) {
    const a = Math.max(s, start);
    const b = Math.min(e, end);
    if (b > a) out.push([a - start, b - start, f]);
  }
  return out.length ? out : undefined;
}

export function concatRuns(a: Run[] | undefined, aLen: number, b: Run[] | undefined): Run[] | undefined {
  const out: Run[] = [...(a ?? []), ...(b ?? []).map(([s, e, f]) => [s + aLen, e + aLen, f] as Run)];
  return out.length ? compress(expand(aLen + Math.max(0, ...(b ?? []).map((r) => r[1])), out)) : undefined;
}

/** Shift runs right by `n` characters (e.g. a "(" was added in front). */
export function shiftRuns(fmt: Run[] | undefined, n: number, len: number): Run[] | undefined {
  if (!fmt?.length) return undefined;
  return compress(expand(len, fmt.map(([s, e, f]) => [s + n, e + n, f] as Run)));
}

/** Toggle `flag` on [start, end): removed if the whole range has it, else added. */
export function toggleRange(text: string, fmt: Run[] | undefined, start: number, end: number, flag: Flag, on?: boolean) {
  const chars = expand(text.length, fmt);
  const all = on ?? !chars.slice(start, end).every((f) => f.includes(flag));
  for (let k = start; k < end; k++) {
    const has = chars[k].includes(flag);
    if (all && !has) chars[k] = sortFlags(chars[k] + flag);
    if (!all && has) chars[k] = chars[k].replace(flag, '');
  }
  return compress(chars);
}

export function hasFlag(text: string, fmt: Run[] | undefined, start: number, end: number, flag: Flag): boolean {
  if (!fmt?.length) return false;
  const chars = expand(text.length, fmt);
  if (end <= start) return (chars[Math.max(0, start - 1)] ?? '').includes(flag);
  return chars.slice(start, end).every((f) => f.includes(flag));
}

/** Read text + runs from a block element (any browser markup is understood). */
export function readRich(el: HTMLElement): { text: string; fmt?: Run[] } {
  const chars: string[] = [];
  let text = '';
  const walk = (node: Node, flags: string) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const s = (node as Text).data.replace(/ /g, ' ').replace(/\n/g, ' ');
      text += s;
      for (let k = 0; k < s.length; k++) chars.push(flags);
      return;
    }
    // Page-break spacers are layout only.
    if (node instanceof HTMLElement && node.classList.contains('pg-break')) return;
    let f = flags;
    if (node instanceof HTMLElement && node !== el) {
      const tag = node.tagName;
      if (tag === 'B' || tag === 'STRONG') f += 'b';
      if (tag === 'I' || tag === 'EM') f += 'i';
      if (tag === 'U' || tag === 'INS') f += 'u';
      if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') f += 's';
      const st = node.style;
      if (st) {
        if (st.fontWeight === 'bold' || Number(st.fontWeight) >= 600) f += 'b';
        if (st.fontStyle === 'italic') f += 'i';
        if (st.textDecoration.includes('underline') || st.textDecorationLine?.includes('underline')) f += 'u';
        if (st.textDecoration.includes('line-through') || st.textDecorationLine?.includes('line-through')) f += 's';
      }
    }
    for (const c of Array.from(node.childNodes)) walk(c, f);
  };
  walk(el, '');
  return { text, fmt: compress(chars.map((f) => sortFlags([...new Set(f)].join('')))) };
}

/** Fill a block element with text + runs as nested <b><i><u><s>. */
export function renderRich(el: HTMLElement, text: string, fmt?: Run[]) {
  el.textContent = '';
  if (!text) {
    el.appendChild(document.createElement('br'));
    return;
  }
  if (!fmt?.length) {
    el.textContent = text;
    return;
  }
  const chars = expand(text.length, fmt);
  let k = 0;
  while (k < text.length) {
    const f = chars[k];
    let e = k + 1;
    while (e < text.length && chars[e] === f) e++;
    let node: Node = document.createTextNode(text.slice(k, e));
    for (const flag of [...f].reverse() as Flag[]) {
      const w = document.createElement(TAG[flag]);
      w.appendChild(node);
      node = w;
    }
    el.appendChild(node);
    k = e;
  }
}

/** Fountain-style emphasis markers for plain-text exports. */
export function toMarkup(text: string, fmt?: Run[]): string {
  if (!fmt?.length) return text;
  const open: Record<Flag, string> = { b: '**', i: '*', u: '_', s: '' };
  let out = '';
  let k = 0;
  const runs = [...fmt].sort((a, b) => a[0] - b[0]);
  for (const [s, e, f] of runs) {
    out += text.slice(k, s);
    let seg = text.slice(s, e);
    // Keep markers tight around the words (Fountain requires it).
    const lead = seg.match(/^\s*/)![0];
    const trail = seg.match(/\s*$/)![0];
    seg = seg.trim();
    if (seg) {
      const marks = (['u', 'b', 'i'] as Flag[]).filter((x) => f.includes(x)).map((x) => open[x]);
      seg = marks.join('') + seg + [...marks].reverse().join('');
    }
    out += lead + seg + trail;
    k = e;
  }
  return out + text.slice(k);
}
