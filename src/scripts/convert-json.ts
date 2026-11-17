/**
 * Read a screenplay from "any reasonable" JSON into Terra Script blocks.
 *
 * Accepted shapes (mixed freely, nested at any depth):
 *  - a list of elements: [{ "type": "scene", "text": "INT. HOUSE - DAY" }, …]
 *  - a document: { "title": "…", "author": "…", "blocks" | "elements" | "script" | "content" | … : [ … ] }
 *  - scenes with their own content: { "heading": "INT. HOUSE - DAY", "elements": [ … ] }
 *  - speech written as one object: { "character": "MAYA", "parenthetical": "quietly", "dialogue": "…" }
 *  - plain strings, which are read like Fountain lines (scene headings, transitions, action)
 * Field names are matched loosely ("sceneHeading", "scene_heading", "slugline" all mean a scene).
 */
import { normalizeTitlePage } from './fountain';
import { SCENE_PREFIX, type Block, type ElType, type ScriptDoc, type TitlePage } from './types';

/** Lower-case letters only: "Scene_Heading" → "sceneheading". */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

const TYPE_NAMES: Record<string, ElType> = {};
const alias = (type: ElType, names: string[]) => names.forEach((n) => (TYPE_NAMES[norm(n)] = type));
alias('scene', ['scene', 'scene heading', 'heading', 'slugline', 'slug', 'location', 'sceneheader', 'sceneheading', 'scene_heading', 'intext']);
alias('action', ['action', 'description', 'desc', 'narrative', 'narration', 'direction', 'stage direction', 'general', 'body', 'paragraph']);
alias('character', ['character', 'char', 'speaker', 'cue', 'charactername']);
alias('dialogue', ['dialogue', 'dialog', 'speech', 'line', 'lines', 'said', 'says', 'spoken']);
alias('parenthetical', ['parenthetical', 'paren', 'parens', 'wryly', 'direction note', 'delivery', 'tone', 'emotion', 'manner']);
alias('transition', ['transition', 'cut', 'trans']);
alias('shot', ['shot', 'camera', 'angle']);
alias('note', ['note', 'notes', 'comment', 'remark']);
alias('lyrics', ['lyrics', 'lyric', 'song', 'singing']);
alias('section', ['section', 'sequence']);
alias('act', ['act', 'actbreak', 'newact']);
alias('endact', ['endact', 'endofact']);
alias('text', ['text element', 'centered', 'centre', 'center']);

/** Keys that hold the element's type, and keys that hold its text. */
const TYPE_KEYS = ['type', 'kind', 'element', 'elementtype', 'style', 'category', 'blocktype', 'format', 'tag'];
const TEXT_KEYS = ['text', 'content', 'value', 'body', 'string', 'words', 'description', 'txt'];
/** Keys that hold a list of child elements. */
const LIST_KEYS = ['blocks', 'elements', 'script', 'content', 'contents', 'body', 'lines', 'paragraphs', 'items', 'data', 'children', 'beats', 'events', 'scenes', 'screenplay', 'pages'];
/** Keys whose content has a known type: { "action": "…" }, { "dialogue": ["…", "…"] }. */
const KEY_HINTS: Record<string, ElType> = {
  action: 'action',
  description: 'action',
  direction: 'action',
  dialogue: 'dialogue',
  dialog: 'dialogue',
  parenthetical: 'parenthetical',
  transition: 'transition',
  shot: 'shot',
  note: 'note',
  notes: 'note',
  lyrics: 'lyrics',
};
/** Keys of a speech written as one object. */
const SPEECH = { character: ['character', 'speaker', 'char', 'name', 'cue'], paren: ['parenthetical', 'paren', 'wryly', 'delivery', 'tone'], line: ['dialogue', 'dialog', 'line', 'lines', 'speech', 'text'] };

const TRANSITION = /^((FADE|CUT|DISSOLVE|SMASH CUT|MATCH CUT|JUMP CUT|WIPE)\b.*(TO:|OUT\.?|IN:?)|[A-Z ]+ TO:)$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Look a field up by loose name. */
function field(o: Obj, names: string[]): unknown {
  const wanted = new Set(names.map(norm));
  for (const [k, v] of Object.entries(o)) if (wanted.has(norm(k))) return v;
  return undefined;
}
const strOf = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join(' ') : '';
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A plain line of text, read the way Fountain would. */
function guessType(text: string): ElType {
  const t = text.trim();
  if (SCENE_PREFIX.test(t)) return 'scene';
  if (TRANSITION.test(t.toUpperCase()) && t === t.toUpperCase()) return 'transition';
  if (/^\(.*\)$/.test(t)) return 'parenthetical';
  return 'action';
}

export interface JsonScript {
  titlePage: Partial<TitlePage>;
  blocks: Block[];
}

export function parseScriptJson(raw: unknown): JsonScript {
  const blocks: Block[] = [];
  const titlePage: Partial<TitlePage> = {};
  const push = (type: ElType, text: string) => {
    let t = clean(text);
    if (!t) return;
    if (type === 'parenthetical' && !t.startsWith('(')) t = `(${t})`;
    if (type === 'scene' || type === 'character' || type === 'transition') t = t.toUpperCase();
    blocks.push({ type, text: t });
  };

  const visit = (v: unknown, depth: number, hint?: ElType) => {
    if (depth > 12 || v == null) return;
    if (typeof v === 'string' || typeof v === 'number') {
      // A string inside a "dialogue" list is dialogue, otherwise read it like Fountain.
      for (const part of String(v).split(/\n{2,}/)) push(hint && hint !== 'scene' ? hint : guessType(part), part);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1, hint);
      return;
    }
    if (!isObj(v)) return;

    // Title page fields at the top of a document.
    if (depth <= 1) {
      const tp = isObj(field(v, ['titlePage', 'title_page', 'meta', 'metadata', 'info'])) ? (field(v, ['titlePage', 'title_page', 'meta', 'metadata', 'info']) as Obj) : v;
      const set = (k: keyof TitlePage, names: string[]) => {
        const s = clean(strOf(field(tp, names)));
        if (s && !titlePage[k]) titlePage[k] = s;
      };
      set('title', ['title', 'name', 'scriptTitle']);
      set('author', ['author', 'authors', 'writer', 'writers', 'by', 'writtenBy']);
      set('credit', ['credit']);
      set('source', ['source', 'basedOn']);
      set('draftDate', ['draftDate', 'date', 'draft']);
      set('contact', ['contact', 'email']);
    }

    // 1) An element with an explicit type.
    const typeName = strOf(field(v, TYPE_KEYS));
    const type = typeName ? TYPE_NAMES[norm(typeName)] : undefined;
    const text = strOf(field(v, TEXT_KEYS));
    if (type && text) {
      push(type, text);
      if (type !== 'scene') return;
    }

    // 2) A speech: { character, parenthetical?, dialogue }.
    const who = clean(strOf(field(v, SPEECH.character)));
    const said = field(v, SPEECH.line);
    if (who && (typeof said === 'string' || Array.isArray(said)) && !type) {
      push('character', who);
      const paren = clean(strOf(field(v, SPEECH.paren)));
      if (paren) push('parenthetical', paren);
      if (Array.isArray(said)) visit(said, depth + 1, 'dialogue');
      else push('dialogue', said as string);
      return;
    }

    // 3) A scene: { heading | slugline | location (+ time), …content }.
    if (!type) {
      let heading = clean(strOf(field(v, ['heading', 'sceneHeading', 'scene_heading', 'slugline', 'slug', 'scene'])));
      if (!heading) {
        const loc = clean(strOf(field(v, ['location', 'place', 'setting'])));
        if (loc) {
          const ie = clean(strOf(field(v, ['intExt', 'int_ext', 'interior'])));
          const time = clean(strOf(field(v, ['time', 'timeOfDay', 'time_of_day'])));
          heading = `${SCENE_PREFIX.test(loc + ' ') ? '' : `${ie || 'INT.'} `}${loc}${time ? ` - ${time}` : ''}`;
        }
      }
      if (heading) push('scene', heading);
      const synopsis = clean(strOf(field(v, ['synopsis', 'summary'])));
      if (heading && synopsis) blocks[blocks.length - 1].synopsis = synopsis;
    }

    // 4) The rest, in the order it appears: lists of children, and text typed by
    //    its key ({ "action": "She runs." }, { "transition": "CUT TO:" }).
    let found = false;
    for (const [k, child] of Object.entries(v)) {
      const key = norm(k);
      const keyType = KEY_HINTS[key];
      if ((Array.isArray(child) || isObj(child)) && (LIST_KEYS.includes(key) || keyType)) {
        found = true;
        visit(child, depth + 1, keyType);
      } else if (typeof child === 'string' && keyType && depth > 0 && !(type && TEXT_KEYS.includes(key))) {
        found = true;
        push(keyType, child);
      }
    }
    // An object with only text and no type: read the text.
    if (!type && !found && !who && text) visit(text, depth + 1, hint);
  };

  visit(raw, 0);
  return { titlePage, blocks };
}

/** JSON that is not a .terra file, turned into a document. Throws when nothing usable is found. */
export function jsonToDoc(text: string, fileName: string): ScriptDoc {
  const { titlePage, blocks } = parseScriptJson(JSON.parse(text));
  if (!blocks.length) throw new Error('empty');
  if (!titlePage.title) titlePage.title = fileName.replace(/\.[^.]+$/, '');
  return { version: 1, titlePage: normalizeTitlePage(titlePage), blocks };
}
