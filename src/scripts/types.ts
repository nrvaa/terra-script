export type ElType =
  | 'scene'
  | 'action'
  | 'character'
  | 'parenthetical'
  | 'dialogue'
  | 'transition'
  | 'shot'
  | 'text'
  | 'note'
  | 'section'
  | 'act'
  | 'endact'
  | 'lyrics';

export interface Block {
  type: ElType;
  text: string;
  /** Only meaningful on `character`: this speaker talks at the same time as the previous one. */
  dual?: boolean;
  /** Only on `scene`: index-card synopsis (not printed). */
  synopsis?: string;
  /** Only on `scene`: index-card colour label. */
  color?: CardColor;
  /** Only on `scene`: production take log. */
  takes?: Take[];
  /** Only on `scene`: storyboard panels (shots), in order. */
  board?: Panel[];
  /** Inline formatting runs: [start, end, flags] with flags from 'bius'. */
  fmt?: Run[];
  /** Manually marked as revised (Revisions → Mark change). */
  mark?: boolean;
  /** Only on `scene`: the scene was omitted; its original blocks are kept here. */
  omit?: Block[];
  /** Only on `scene`: locked scene number (Production → Scene numbers → Lock). */
  num?: string;
  /** Only on `scene`: always start this scene on a new page. */
  newPage?: boolean;
  /** Locked page that starts at wrapped line `pgLine` of this block. */
  pg?: string;
  pgLine?: number;
}

/** Inline style run: characters [start, end) get the flags b(old) i(talic) u(nderline) s(trike). */
export type Run = [number, number, string];

export interface ElementStyle {
  caps: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** Blank lines before the element. */
  before: number;
}

/** Built-in look of every element (what Customize → Format starts from). */
export const DEFAULT_STYLES: Record<ElType, ElementStyle> = {
  scene: { caps: true, bold: true, italic: false, underline: false, before: 2 },
  action: { caps: false, bold: false, italic: false, underline: false, before: 1 },
  character: { caps: true, bold: false, italic: false, underline: false, before: 1 },
  parenthetical: { caps: false, bold: false, italic: false, underline: false, before: 0 },
  dialogue: { caps: false, bold: false, italic: false, underline: false, before: 0 },
  transition: { caps: true, bold: false, italic: false, underline: false, before: 1 },
  shot: { caps: true, bold: false, italic: false, underline: false, before: 1 },
  text: { caps: false, bold: false, italic: false, underline: false, before: 1 },
  note: { caps: false, bold: false, italic: true, underline: false, before: 1 },
  section: { caps: false, bold: true, italic: false, underline: false, before: 2 },
  act: { caps: true, bold: true, italic: false, underline: true, before: 2 },
  endact: { caps: true, bold: true, italic: false, underline: true, before: 2 },
  lyrics: { caps: false, bold: false, italic: true, underline: false, before: 0 },
};

export function elementStyle(layout: ScriptLayout | undefined, type: ElType): ElementStyle {
  return { ...DEFAULT_STYLES[type], ...(layout?.styles?.[type] ?? {}) };
}

/** Industry revision colours, in the order a production goes through them. */
export const REV_COLORS = ['blue', 'pink', 'yellow', 'green', 'goldenrod', 'buff', 'salmon', 'cherry', 'white'] as const;
export type RevColor = (typeof REV_COLORS)[number];
export const REV_HEX: Record<RevColor, string> = {
  blue: '#4c8dff',
  pink: '#f472b6',
  yellow: '#eab308',
  green: '#22c55e',
  goldenrod: '#d4a017',
  buff: '#c8a27c',
  salmon: '#fa8072',
  cherry: '#de3163',
  white: '#9ca3af',
};

export interface Revision {
  color: RevColor;
  /** Shown in the page header of revised pages. */
  date: string;
  /** Text of the script when tracking started; changes are measured against it. */
  baseline?: { type: ElType; text: string }[];
}

export const TAG_CATS = [
  'cast',
  'extras',
  'props',
  'wardrobe',
  'makeup',
  'vehicles',
  'animals',
  'sfx',
  'vfx',
  'sound',
  'music',
  'stunts',
  'setdressing',
  'equipment',
] as const;
export type TagCat = (typeof TAG_CATS)[number];
export const TAG_HEX: Record<TagCat, string> = {
  cast: '#ef4444',
  extras: '#f59e0b',
  props: '#8b5cf6',
  wardrobe: '#06b6d4',
  makeup: '#ec4899',
  vehicles: '#64748b',
  animals: '#84cc16',
  sfx: '#f97316',
  vfx: '#3b82f6',
  sound: '#14b8a6',
  music: '#a855f7',
  stunts: '#dc2626',
  setdressing: '#a16207',
  equipment: '#0ea5e9',
};

export interface Tag {
  text: string;
  cat: TagCat;
}

export type TakeStatus = 'good' | 'maybe' | 'skip';
export const TAKE_STATUSES: TakeStatus[] = ['good', 'maybe', 'skip'];

export interface Take {
  id: string;
  slate: string;
  take: string;
  camera: string;
  roll: string;
  /** '' = not rated yet */
  status: TakeStatus | '';
  note: string;
  /** When the take was logged (ms since epoch). */
  at: number;
}

/** Overall result for a scene: best rated take wins. */
export function sceneTakeStatus(takes: Take[] | undefined): TakeStatus | 'pending' | null {
  if (!takes?.length) return null;
  if (takes.some((t) => t.status === 'good')) return 'good';
  if (takes.some((t) => t.status === 'maybe')) return 'maybe';
  if (takes.some((t) => t.status === 'skip')) return 'skip';
  return 'pending';
}

export type CardColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';
export const CARD_COLORS: CardColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];

/** Page layout that travels with the script so it looks the same on every device. */
export interface ScriptLayout {
  paper: 'letter' | 'a4';
  sceneNumbers: boolean;
  sceneNumberSide?: 'left' | 'right' | 'both';
  sceneNumbersLocked?: boolean;
  /** Letters for scenes added after locking: 'suffix' = 12A (default), 'prefix' = A13. */
  sceneLetterStyle?: 'suffix' | 'prefix';
  pagesLocked?: boolean;
  /** Header / footer slots: [left, centre, right]. Tokens: {page} {title} {date} {rev}. */
  header?: [string, string, string];
  footer?: [string, string, string];
  /** Show header/footer on page 1 too. */
  firstPageHeader?: boolean;
  /** Split dialogue across pages with (MORE) / (CONT'D). */
  more?: boolean;
  moreText?: string;
  contdText?: string;
  /** Add (CONT'D) when a character speaks again after an interruption in the same scene (on unless false). */
  autoContd?: boolean;
  /** CONTINUED: / (CONTINUED) when a scene runs over a page break. */
  sceneContinueds?: boolean;
  watermark?: string;
  /** Asterisks in the right margin and a revision label on revised pages. */
  revMarks?: boolean;
  styles?: Partial<Record<ElType, Partial<ElementStyle>>>;
  /** Storyboard frame shape. */
  boardAspect?: BoardAspect;
}

/* Storyboard ---------------------------------------------------------- */

/** Shot sizes, as written on storyboards (the abbreviations are the same in every language). */
export const SHOT_SIZES = ['ews', 'ws', 'fs', 'ms', 'mcu', 'cu', 'ecu', 'ots', 'pov', 'ins'] as const;
export type ShotSize = (typeof SHOT_SIZES)[number];
export const SHOT_ABBR: Record<ShotSize, string> = {
  ews: 'EWS',
  ws: 'WS',
  fs: 'FS',
  ms: 'MS',
  mcu: 'MCU',
  cu: 'CU',
  ecu: 'ECU',
  ots: 'OTS',
  pov: 'POV',
  ins: 'INSERT',
};
export const SHOT_ANGLES = ['eye', 'high', 'low', 'top', 'dutch'] as const;
export type ShotAngle = (typeof SHOT_ANGLES)[number];
export const CAMERA_MOVES = ['static', 'pan', 'tilt', 'dolly', 'truck', 'zoom', 'crane', 'handheld'] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

export const BOARD_ASPECTS = ['16:9', '1.85', '2.39', '4:3', '1:1', '9:16'] as const;
export type BoardAspect = (typeof BOARD_ASPECTS)[number];
/** Width / height of each frame shape. */
export const ASPECT_RATIO: Record<BoardAspect, number> = {
  '16:9': 16 / 9,
  '1.85': 1.85,
  '2.39': 2.39,
  '4:3': 4 / 3,
  '1:1': 1,
  '9:16': 9 / 16,
};

/** One storyboard panel. The drawing is stored separately (see projects.ts), by `img` id. */
export interface Panel {
  id: string;
  img?: string;
  shot?: ShotSize;
  angle?: ShotAngle;
  move?: CameraMove;
  /** Free text, e.g. "3s". */
  dur?: string;
  /** What happens in the shot: action, dialogue, sound. */
  note?: string;
}

export const DEFAULT_HEADER: [string, string, string] = ['', '', '{page}.'];
export const DEFAULT_FOOTER: [string, string, string] = ['', '', ''];

export interface TitlePage {
  title: string;
  credit: string;
  author: string;
  source: string;
  draftDate: string;
  contact: string;
}

export interface ScriptDoc {
  version: number;
  titlePage: TitlePage;
  blocks: Block[];
  layout?: ScriptLayout;
  revision?: Revision;
  tags?: Tag[];
  /**
   * Storyboard drawings as data URLs, by id. Only present while a project
   * travels in a .terra file; in the app they live in their own store.
   */
  images?: Record<string, string>;
}

/** 0 → A, 25 → Z, 26 → AA. */
const letters = (k: number): string => (k < 26 ? String.fromCharCode(65 + k) : letters(Math.floor(k / 26) - 1) + letters(k % 26));

/**
 * Scene number of every scene heading (block index → label).
 * Locked: scenes keep their stored number; scenes added later get letters:
 *  - suffix style: after 12 → 12A, 12B…
 *  - prefix style: before 13 → A13, B13…
 * Scenes added before the first scene are always A1, B1…
 */
export function sceneLabels(
  blocks: Block[],
  layout: Pick<ScriptLayout, 'sceneNumbersLocked' | 'sceneLetterStyle'> | boolean = false,
): Map<number, string> {
  const opts = typeof layout === 'boolean' ? { sceneNumbersLocked: layout } : layout;
  const out = new Map<number, string>();
  const scenes = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.type === 'scene');
  if (!opts.sceneNumbersLocked || !scenes.some(({ b }) => b.num)) {
    scenes.forEach(({ i }, k) => out.set(i, String(k + 1)));
    return out;
  }
  const prefix = opts.sceneLetterStyle === 'prefix';
  const taken = new Set(scenes.filter(({ b }) => b.num).map(({ b }) => b.num!));
  const unique = (make: (k: number) => string) => {
    for (let k = 0; ; k++) {
      const label = make(k);
      if (!taken.has(label)) {
        taken.add(label);
        return label;
      }
    }
  };
  let k = 0;
  while (k < scenes.length) {
    if (scenes[k].b.num) {
      out.set(scenes[k].i, scenes[k].b.num!);
      k++;
      continue;
    }
    // A run of new scenes between two numbered ones.
    let end = k;
    while (end < scenes.length && !scenes[end].b.num) end++;
    const prev = k > 0 ? scenes[k - 1].b.num! : null;
    const next = end < scenes.length ? scenes[end].b.num! : null;
    const usePrefix = next !== null && (prefix || prev === null);
    let last = prev ?? '';
    for (let j = k; j < end; j++) {
      const label = usePrefix
        ? unique((n) => letters(n) + next)
        : unique((n) => {
            let l = last;
            for (let s = 0; s <= n; s++) l = nextLetter(l);
            return l;
          });
      last = label;
      out.set(scenes[j].i, label);
    }
    k = end;
  }
  return out;
}

/** 12 → 12A, 12A → 12B, 12Z → 12AA. */
export function nextLetter(label: string): string {
  const m = label.match(/^(.*?)([A-Z]*)$/)!;
  const base = m[1];
  const letters = m[2];
  if (!letters) return `${base}A`;
  const chars = letters.split('');
  let k = chars.length - 1;
  while (k >= 0 && chars[k] === 'Z') chars[k--] = 'A';
  if (k < 0) chars.unshift('A');
  else chars[k] = String.fromCharCode(chars[k].charCodeAt(0) + 1);
  return base + chars.join('');
}

/**
 * Character cues that get an automatic (CONT'D): the same character speaks
 * again in the same scene with only action (no other speaker) in between.
 */
export function autoContdCues(blocks: Block[]): Set<number> {
  const out = new Set<number>();
  let last = '';
  blocks.forEach((b, i) => {
    if (b.type === 'scene' || b.type === 'act' || b.type === 'transition') last = '';
    else if (b.type === 'character') {
      const name = characterName(b.text);
      if (name && name === last && !/CONT'?D/i.test(b.text) && !b.dual) out.add(i);
      last = name;
    }
  });
  return out;
}

export interface ElementDef {
  type: ElType;
  label: string;
  /** Alt + key shortcut, if any. */
  key?: string;
  icon: string;
}

const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ELEMENTS: ElementDef[] = [
  {
    type: 'scene',
    label: 'Scene',
    key: '1',
    icon: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="m21 15-5-5L5 19"/>'),
  },
  {
    type: 'action',
    label: 'Action',
    key: '2',
    icon: svg('<path d="M3 10v4h3l6 4V6L6 10H3z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M19 6a8 8 0 0 1 0 12"/>'),
  },
  {
    type: 'character',
    label: 'Character',
    key: '3',
    icon: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  },
  {
    type: 'parenthetical',
    label: 'Parens',
    key: '4',
    icon: svg('<path d="M9 4c-3.5 3.5-3.5 12.5 0 16"/><path d="M15 4c3.5 3.5 3.5 12.5 0 16"/>'),
  },
  {
    type: 'dialogue',
    label: 'Dialogue',
    key: '5',
    icon: svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>'),
  },
  {
    type: 'transition',
    label: 'Transition',
    key: '6',
    icon: svg('<path d="M4 8h15l-4-4"/><path d="M20 16H5l4 4"/>'),
  },
  {
    type: 'shot',
    label: 'Shot',
    key: '7',
    icon: svg('<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/>'),
  },
  {
    type: 'text',
    label: 'Text',
    key: '8',
    icon: svg('<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>'),
  },
  {
    type: 'note',
    label: 'Note',
    key: '9',
    icon: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 16.5v.5"/>'),
  },
  {
    type: 'section',
    label: 'Sequence',
    icon: svg('<path d="M4 6h16"/><path d="M8 12h12"/><path d="M4 18h16"/>'),
  },
  {
    type: 'act',
    label: 'New Act',
    icon: svg('<path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/>'),
  },
  {
    type: 'endact',
    label: 'End Act',
    icon: svg('<rect x="6" y="6" width="12" height="12" rx="1.5"/>'),
  },
  {
    type: 'lyrics',
    label: 'Lyrics',
    key: '0',
    icon: svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  },
];

export const DUAL_ICON = svg(
  '<path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/>',
);

export const LABELS: Record<ElType, string> = Object.fromEntries(
  ELEMENTS.map((e) => [e.type, e.label]),
) as Record<ElType, string>;

/** Type of the new element created by pressing Enter at the end of a non-empty element. */
export const NEXT_ON_ENTER: Record<ElType, ElType> = {
  scene: 'action',
  action: 'action',
  character: 'dialogue',
  parenthetical: 'dialogue',
  dialogue: 'action',
  transition: 'scene',
  shot: 'action',
  text: 'action',
  note: 'action',
  section: 'scene',
  act: 'scene',
  endact: 'act',
  lyrics: 'lyrics',
};

/** Pressing Enter inside an EMPTY element changes its type instead of adding a new line. */
export const EMPTY_ENTER: Partial<Record<ElType, ElType>> = {
  action: 'character',
  character: 'action',
  dialogue: 'action',
  parenthetical: 'dialogue',
  lyrics: 'action',
  scene: 'action',
};

export const TAB_NEXT: Record<ElType, ElType> = {
  action: 'character',
  character: 'transition',
  transition: 'scene',
  scene: 'action',
  dialogue: 'parenthetical',
  parenthetical: 'dialogue',
  lyrics: 'dialogue',
  shot: 'action',
  text: 'action',
  note: 'action',
  section: 'scene',
  act: 'scene',
  endact: 'act',
};

export const SHIFT_TAB_NEXT: Record<ElType, ElType> = {
  action: 'scene',
  scene: 'transition',
  transition: 'character',
  character: 'action',
  dialogue: 'character',
  parenthetical: 'dialogue',
  lyrics: 'dialogue',
  shot: 'action',
  text: 'action',
  note: 'action',
  section: 'action',
  act: 'section',
  endact: 'act',
};

export const UPPERCASE_TYPES: ElType[] = ['scene', 'character', 'transition', 'shot', 'act', 'endact'];

export const emptyTitlePage = (): TitlePage => ({
  title: '',
  credit: 'Written by',
  author: '',
  source: '',
  draftDate: '',
  contact: '',
});

export const SCENE_PREFIX = /^(INT\.?\/EXT|EXT\.?\/INT|I\/E|INT|EXT|EST)[.\s]/i;

/** Character name without extensions such as (V.O.) or (CONT'D). */
export const characterName = (text: string) =>
  text
    .replace(/\^\s*$/, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\([^)]*$/, '') // an extension still being typed: "MAYA (V."
    .trim()
    .toUpperCase();
