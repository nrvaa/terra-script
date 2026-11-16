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
}

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
