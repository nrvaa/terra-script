import {
  SCENE_PREFIX,
  emptyTitlePage,
  type Block,
  type ElType,
  type TitlePage,
} from './types';

const TITLE_KEYS: Record<string, keyof TitlePage> = {
  title: 'title',
  credit: 'credit',
  author: 'author',
  authors: 'author',
  source: 'source',
  'draft date': 'draftDate',
  date: 'draftDate',
  contact: 'contact',
};

const hasLetters = (s: string) => /\p{L}/u.test(s);
const isAllCaps = (s: string) => hasLetters(s) && s === s.toUpperCase();
const stripSceneNumber = (s: string) => s.replace(/\s*#[^#]*#\s*$/, '');

/** Parse Fountain (https://fountain.io) text. Also used for multi-line paste. */
export function parseFountain(src: string): { titlePage: Partial<TitlePage>; blocks: Block[] } {
  let text = src.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const titlePage: Partial<TitlePage> = {};

  // Title page: "Key: value" lines at the very top, ended by a blank line.
  const lines0 = text.split('\n');
  let start = 0;
  while (start < lines0.length && lines0[start].trim() === '') start++;
  if (/^(title|credit|author|authors|source|draft date|date|contact)\s*:/i.test(lines0[start] ?? '')) {
    let key: keyof TitlePage | null = null;
    let i = start;
    for (; i < lines0.length && lines0[i].trim() !== ''; i++) {
      const line = lines0[i];
      const m = line.match(/^([A-Za-z ]+):\s*(.*)$/);
      if (m && !/^\s/.test(line)) {
        key = TITLE_KEYS[m[1].trim().toLowerCase()] ?? null;
        if (key) titlePage[key] = m[2].trim();
      } else if (key) {
        const prev = titlePage[key];
        titlePage[key] = prev ? `${prev}\n${line.trim()}` : line.trim();
      }
    }
    text = lines0.slice(i).join('\n');
  }

  const lines = text.split('\n');
  const blocks: Block[] = [];
  let prevBlank = true;
  let inDialogue = false;
  const push = (type: ElType, t: string, extra: Partial<Block> = {}) => blocks.push({ type, text: t, ...extra });

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    const next = (lines[i + 1] ?? '').trim();

    if (t === '') {
      prevBlank = true;
      inDialogue = false;
      continue;
    }

    if (inDialogue) {
      if (t.startsWith('(') ) push('parenthetical', t);
      else if (t.startsWith('~')) push('lyrics', t.slice(1).trim());
      else push('dialogue', t);
      prevBlank = false;
      continue;
    }

    let m: RegExpMatchArray | null;
    if ((m = t.match(/^\[\[([\s\S]*)\]\]$/))) push('note', m[1].trim());
    else if ((m = t.match(/^(#+)\s*(.*)$/))) push(m[1].length === 1 ? 'act' : 'section', m[2]);
    else if (/^={3,}$/.test(t)) {
      /* page break: ignored */
    } else if (t.startsWith('=')) {
      // Synopsis: attach to the scene it follows (index-card text), else keep as a note.
      const last = blocks[blocks.length - 1];
      const syn = t.slice(1).trim();
      if (last?.type === 'scene') last.synopsis = last.synopsis ? `${last.synopsis}\n${syn}` : syn;
      else push('note', syn);
    }
    else if (t.startsWith('~')) push('lyrics', t.slice(1).trim());
    else if (t.startsWith('!')) push('action', t.slice(1));
    else if (/^\.[^.]/.test(t)) push('scene', stripSceneNumber(t.slice(1).trim()));
    else if ((m = t.match(/^>\s*(.*?)\s*<$/))) push(/^END OF\b/i.test(m[1]) ? 'endact' : 'text', m[1]);
    else if (t.startsWith('>')) push('transition', t.slice(1).trim());
    else if (t.startsWith('@')) {
      const dual = /\^\s*$/.test(t);
      push('character', t.slice(1).replace(/\^\s*$/, '').trim(), dual ? { dual } : {});
      inDialogue = next !== '';
    } else if (prevBlank && SCENE_PREFIX.test(t)) push('scene', stripSceneNumber(t));
    else if (prevBlank && isAllCaps(t) && /TO:$/.test(t) && next === '') push('transition', t);
    else if (prevBlank && next !== '' && isAllCaps(t.replace(/\(.*?\)/g, '')) && !/[.!?:]$/.test(t.replace(/\(.*?\)\s*\^?$/, ''))) {
      const dual = /\^\s*$/.test(t);
      push('character', t.replace(/\^\s*$/, '').trim(), dual ? { dual } : {});
      inDialogue = true;
    } else push('action', raw.replace(/^\s+/, '').replace(/\t/g, '    '));

    prevBlank = false;
  }

  return { titlePage, blocks };
}

const DIALOGUE_PART: ElType[] = ['character', 'parenthetical', 'dialogue', 'lyrics'];

export function toFountain(blocks: Block[], titlePage?: TitlePage): string {
  const out: string[] = [];

  if (titlePage && titlePage.title.trim()) {
    const tp: [string, string][] = [
      ['Title', titlePage.title],
      ['Credit', titlePage.credit],
      ['Author', titlePage.author],
      ['Source', titlePage.source],
      ['Draft date', titlePage.draftDate],
      ['Contact', titlePage.contact],
    ];
    for (const [k, v] of tp) {
      if (!v.trim()) continue;
      const parts = v.split('\n');
      if (parts.length === 1) out.push(`${k}: ${v.trim()}`);
      else out.push(`${k}:`, ...parts.map((p) => `    ${p.trim()}`));
    }
    out.push('');
  }

  let prev: Block | undefined;
  for (const b of blocks) {
    const t = b.text.trim();
    const continuesDialogue =
      prev && DIALOGUE_PART.includes(prev.type) && ['parenthetical', 'dialogue', 'lyrics'].includes(b.type);
    if (out.length && !continuesDialogue) out.push('');

    switch (b.type) {
      case 'scene': {
        const up = t.toUpperCase();
        out.push(SCENE_PREFIX.test(up) ? up : `.${up}`);
        if (b.synopsis?.trim()) {
          out.push('');
          for (const line of b.synopsis.split('\n')) if (line.trim()) out.push(`= ${line.trim()}`);
        }
        break;
      }
      case 'action':
        // Force action if Fountain would otherwise read it as something else.
        out.push(
          SCENE_PREFIX.test(t) || isAllCaps(t) || /^[.!@#~>=[]/.test(t) ? `!${b.text}` : b.text,
        );
        break;
      case 'character': {
        const up = t.toUpperCase();
        const forced = hasLetters(up.replace(/\(.*?\)/g, '')) ? up : `@${up}`;
        out.push(b.dual ? `${forced} ^` : forced);
        break;
      }
      case 'parenthetical':
        out.push(t.startsWith('(') ? t : `(${t})`);
        break;
      case 'dialogue':
        out.push(t || ' ');
        break;
      case 'lyrics':
        out.push(`~${t}`);
        break;
      case 'transition': {
        const up = t.toUpperCase();
        out.push(/TO:$/.test(up) ? up : `> ${up}`);
        break;
      }
      case 'shot':
        out.push(`!${t.toUpperCase()}`);
        break;
      case 'text':
        out.push(`> ${t} <`);
        break;
      case 'note':
        out.push(`[[${t}]]`);
        break;
      case 'act':
        out.push(`# ${t.toUpperCase()}`);
        break;
      case 'section':
        out.push(`## ${t}`);
        break;
      case 'endact': {
        const up = t.toUpperCase();
        out.push(`> ${/^END OF\b/.test(up) ? up : `END OF ${up}`} <`);
        break;
      }
    }
    prev = b;
  }
  return out.join('\n') + '\n';
}

/** Plain text export roughly matching the printed layout (monospace columns). */
export function toPlainText(blocks: Block[], titlePage?: TitlePage): string {
  const W = 60; // characters across the text area (6 inch @ 10 cpi)
  const wrap = (s: string, width: number) => {
    const words = s.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > width && cur) {
        lines.push(cur);
        cur = w;
      } else cur = (cur + ' ' + w).trim();
    }
    if (cur || !lines.length) lines.push(cur);
    return lines;
  };
  const pad = (n: number) => ' '.repeat(n);
  const out: string[] = [];

  if (titlePage?.title.trim()) {
    const center = (s: string) => pad(Math.max(0, Math.floor((W - s.length) / 2))) + s;
    out.push('', '', '', center(titlePage.title.toUpperCase()), '');
    if (titlePage.credit) out.push(center(titlePage.credit));
    if (titlePage.author) out.push('', center(titlePage.author));
    if (titlePage.source) out.push('', center(titlePage.source));
    out.push('', '', '');
    if (titlePage.draftDate) out.push(titlePage.draftDate);
    if (titlePage.contact) out.push(...titlePage.contact.split('\n'));
    out.push('', '\f');
  }

  let prev: Block | undefined;
  for (const b of blocks) {
    if (b.type === 'note' || b.type === 'section') continue;
    const t = b.text.trim();
    const tight = prev && DIALOGUE_PART.includes(prev.type) && ['parenthetical', 'dialogue', 'lyrics'].includes(b.type);
    if (out.length && !tight) out.push('');
    switch (b.type) {
      case 'character':
        out.push(pad(20) + t.toUpperCase());
        break;
      case 'dialogue':
      case 'lyrics':
        out.push(...wrap(t, 35).map((l) => pad(10) + l));
        break;
      case 'parenthetical':
        out.push(...wrap(t, 25).map((l) => pad(15) + l));
        break;
      case 'transition': {
        const up = t.toUpperCase();
        out.push(pad(Math.max(0, W - up.length)) + up);
        break;
      }
      case 'text':
      case 'act':
      case 'endact': {
        const s = b.type === 'text' ? t : t.toUpperCase();
        out.push(...wrap(s, W).map((l) => pad(Math.max(0, Math.floor((W - l.length) / 2))) + l));
        break;
      }
      case 'scene':
      case 'shot':
        out.push(...wrap(t.toUpperCase(), W));
        break;
      default:
        out.push(...wrap(t, W));
    }
    prev = b;
  }
  return out.join('\n') + '\n';
}

export function normalizeTitlePage(tp: Partial<TitlePage> | undefined): TitlePage {
  return { ...emptyTitlePage(), ...(tp ?? {}) };
}
