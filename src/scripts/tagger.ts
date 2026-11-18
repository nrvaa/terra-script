/**
 * Tagger: mark props, wardrobe, vehicles… in the script for a production
 * breakdown. A tag is a word or phrase plus a category; every occurrence in
 * the script is highlighted (CSS Custom Highlight API: nothing is inserted
 * into the editable text) and listed per scene in the breakdown.
 */
import { t, type Key } from './i18n';
import { TAG_CATS, characterName, sceneLabels, type Block, type ScriptLayout, type Tag, type TagCat } from './types';

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const tagRegex = (text: string) => new RegExp(`(?<![\\p{L}\\p{N}_])${escRe(text)}(?![\\p{L}\\p{N}_])`, 'giu');

export const catLabel = (c: TagCat) => t(`tag.${c}` as Key);

type HighlightRegistry = Map<string, unknown> & { set(name: string, h: unknown): void; delete(name: string): boolean };
declare const Highlight: { new (...ranges: Range[]): unknown } | undefined;

function registry(): HighlightRegistry | null {
  const css = (globalThis as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return css?.highlights && typeof Highlight !== 'undefined' ? css.highlights : null;
}

/** Paint `ranges` as the named CSS highlight (none: remove it). No-op without the Highlight API. */
export function paintHighlight(name: string, ranges: Range[]) {
  const reg = registry();
  if (!reg) return;
  if (ranges.length) reg.set(name, new Highlight!(...ranges));
  else reg.delete(name);
}

/** Text of a block element with a way back from text offsets to DOM positions. */
export function textIndex(el: HTMLElement) {
  const nodes: { node: Text; start: number }[] = [];
  let text = '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    nodes.push({ node: n as Text, start: text.length });
    text += (n as Text).data;
  }
  const at = (offset: number): [Text, number] | null => {
    for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k].start <= offset) return [nodes[k].node, offset - nodes[k].start];
    return null;
  };
  return { text, at };
}

/** Highlight every tagged word in the editor (or clear the highlights). */
export function paintTags(editor: HTMLElement, tags: Tag[], on: boolean) {
  const reg = registry();
  if (!reg) return;
  for (const c of TAG_CATS) reg.delete(`tag-${c}`);
  if (!on || !tags.length) return;
  const byCat = new Map<TagCat, Range[]>();
  const regs = tags.map((tg) => ({ cat: tg.cat, re: tagRegex(tg.text) }));
  for (const el of Array.from(editor.children) as HTMLElement[]) {
    if (el.dataset.type === 'note') continue;
    const idx = textIndex(el);
    if (!idx.text.trim()) continue;
    for (const { cat, re } of regs) {
      re.lastIndex = 0;
      for (const m of idx.text.matchAll(re)) {
        const a = idx.at(m.index!);
        const b = idx.at(m.index! + m[0].length);
        if (!a || !b) continue;
        const r = document.createRange();
        try {
          r.setStart(a[0], a[1]);
          r.setEnd(b[0], b[1]);
        } catch {
          continue;
        }
        if (!byCat.has(cat)) byCat.set(cat, []);
        byCat.get(cat)!.push(r);
      }
    }
  }
  for (const [cat, ranges] of byCat) reg.set(`tag-${cat}`, new Highlight!(...ranges));
}

export interface BreakdownScene {
  index: number;
  label: string;
  heading: string;
  items: Map<TagCat, string[]>;
}

/** Which tagged items appear in each scene. */
export function breakdown(blocks: Block[], tags: Tag[], layout: ScriptLayout | boolean = false): BreakdownScene[] {
  const labels = sceneLabels(blocks, layout);
  const scenes: BreakdownScene[] = [];
  let cur: BreakdownScene | null = null;
  const regs = tags.map((tg) => ({ tg, re: tagRegex(tg.text) }));
  blocks.forEach((b, i) => {
    if (b.type === 'scene') {
      cur = { index: i, label: labels.get(i) ?? '', heading: b.text.toUpperCase(), items: new Map() };
      scenes.push(cur);
    }
    if (!cur || b.type === 'note') return;
    const scene: BreakdownScene = cur;
    for (const { tg, re } of regs) {
      re.lastIndex = 0;
      if (!re.test(b.text)) continue;
      const list = scene.items.get(tg.cat) ?? [];
      if (!list.includes(tg.text)) list.push(tg.text);
      scene.items.set(tg.cat, list);
    }
  });
  return scenes;
}

/** Breakdown as CSV (one row per scene, one column per category used). */
export function breakdownCsv(scenes: BreakdownScene[], tags: Tag[]): string {
  const cats = TAG_CATS.filter((c) => tags.some((tg) => tg.cat === c));
  const cell = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const head = [t('tag.scene'), t('tag.heading'), ...cats.map(catLabel)].map(cell).join(',');
  const rows = scenes.map((s) => [s.label, s.heading, ...cats.map((c) => (s.items.get(c) ?? []).join(', '))].map(cell).join(','));
  return '﻿' + [head, ...rows].join('\r\n') + '\r\n';
}

/** Speaking characters not tagged yet (to add them to Cast in one click). */
export function untaggedCast(blocks: Block[], tags: Tag[]): string[] {
  const have = new Set(tags.map((tg) => tg.text.toUpperCase()));
  const names = new Set<string>();
  for (const b of blocks) if (b.type === 'character') {
    const n = characterName(b.text);
    if (n && !have.has(n)) names.add(n);
  }
  return [...names];
}

/** How many scenes each tag appears in. */
export function tagSceneCounts(scenes: BreakdownScene[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of scenes) for (const list of s.items.values()) for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
}
