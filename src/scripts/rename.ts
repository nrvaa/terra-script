/**
 * Rename a character across the whole script.
 *  - Character cues: the name is swapped, extensions like (V.O.) / (CONT'D) stay.
 *  - Optionally every other mention (action, dialogue, parentheticals, scene
 *    headings, notes, card synopses) as a whole word, keeping its case:
 *    MAYA → RANI, Maya → Rani, maya → rani.
 */
import { characterName, type Block } from './types';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasLetters = (s: string) => /\p{L}/u.test(s);

function titleCase(s: string) {
  return s.toLowerCase().replace(/(^|[\s\-'’.])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** Write `to` in the same capitalisation style as the matched text. */
export function matchCase(found: string, to: string): string {
  if (!hasLetters(found)) return to;
  // A single capital ("A", "I") reads as a capitalised word, not shouting.
  if ((found.match(/\p{L}/gu) ?? []).length === 1 && found === found.toUpperCase()) return titleCase(to);
  if (found === found.toUpperCase()) return to.toUpperCase();
  if (found === found.toLowerCase()) return to.toLowerCase();
  if (found === titleCase(found)) return titleCase(to);
  return to;
}

export interface RenameResult {
  blocks: Block[];
  cues: number;
  mentions: number;
}

export function renameCharacter(blocks: Block[], from: string, to: string, opts: { inText: boolean }): RenameResult {
  const name = characterName(from);
  const target = to.trim();
  if (!name || !target) return { blocks, cues: 0, mentions: 0 };

  const cueRe = new RegExp(`^(\\s*)${escapeRe(name)}`, 'iu');
  // Whole word: not glued to other letters/digits on either side.
  const wordRe = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(name)}(?![\\p{L}\\p{N}_])`, 'giu');
  let cues = 0;
  let mentions = 0;
  const swap = (text: string) =>
    text.replace(wordRe, (found) => {
      mentions++;
      return matchCase(found, target);
    });

  const out = blocks.map((b) => {
    if (b.type === 'character') {
      if (characterName(b.text) !== name) return b;
      cues++;
      return { ...b, text: b.text.replace(cueRe, (_, lead: string) => lead + target.toUpperCase()) };
    }
    if (!opts.inText) return b;
    const text = swap(b.text);
    const synopsis = b.synopsis ? swap(b.synopsis) : b.synopsis;
    return text === b.text && synopsis === b.synopsis ? b : { ...b, text, ...(synopsis !== undefined ? { synopsis } : {}) };
  });
  return { blocks: out, cues, mentions };
}
