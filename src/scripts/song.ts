/**
 * Songwriting: the song document and everything about it that doesn't touch
 * the DOM — section labels, syllables, rhymes, chords and transposing, plain
 * text export and the .terra song file format.
 *
 * Chords live in a "chord lane": a line of text above each lyric line, in the
 * same monospaced font, so a chord sits over the syllable in the same column.
 * That is how chord sheets are written by hand and survives any export.
 */

export type SectionKind = 'intro' | 'verse' | 'prechorus' | 'chorus' | 'bridge' | 'hook' | 'interlude' | 'outro';

/** Section names are music terms and stay in English in every language (like screenplay elements). */
export const SECTION_KINDS: { kind: SectionKind; label: string; key: string }[] = [
  { kind: 'intro', label: 'Intro', key: '1' },
  { kind: 'verse', label: 'Verse', key: '2' },
  { kind: 'prechorus', label: 'Pre-Chorus', key: '3' },
  { kind: 'chorus', label: 'Chorus', key: '4' },
  { kind: 'bridge', label: 'Bridge', key: '5' },
  { kind: 'hook', label: 'Hook', key: '6' },
  { kind: 'interlude', label: 'Interlude', key: '7' },
  { kind: 'outro', label: 'Outro', key: '8' },
];
const KIND_SET = new Set<string>(SECTION_KINDS.map((k) => k.kind));
export const kindLabel = (k: SectionKind) => SECTION_KINDS.find((x) => x.kind === k)?.label ?? k;

/** Enter on an empty last line starts the section that usually comes next. */
export const NEXT_SECTION: Record<SectionKind, SectionKind> = {
  intro: 'verse',
  verse: 'chorus',
  prechorus: 'chorus',
  chorus: 'verse',
  bridge: 'chorus',
  hook: 'verse',
  interlude: 'verse',
  outro: 'outro',
};

export interface SongLine {
  lyric: string;
  /** Chord lane: chords placed by column over the lyric. */
  chords: string;
}

export interface SongSection {
  id: string;
  kind: SectionKind;
  lines: SongLine[];
  /** A repeat ("Chorus" again) shows another section's lines instead of its own. */
  repeatOf?: string;
}

export type SongLang = 'id' | 'en';

export type NoteColor = 'yellow' | 'pink' | 'blue' | 'green' | 'purple';
export const NOTE_COLORS: NoteColor[] = ['yellow', 'pink', 'blue', 'green', 'purple'];

/** A sticky note beside the sheet; x / y are in px from the sheet's top-left corner (x < 0 = left margin). */
export interface StickyNote {
  id: string;
  x: number;
  y: number;
  text: string;
  color: NoteColor;
}

export interface SongDoc {
  version: 1;
  /** Tracks in an album have an id (singles don't need one). */
  id?: string;
  title: string;
  writer: string;
  /** Musical key, e.g. "G" or "Em". */
  key: string;
  bpm: string;
  time: string;
  capo: string;
  /** Language of the lyrics: decides how syllables and rhymes are counted. */
  lang: SongLang;
  sections: SongSection[];
  /** The writer's sticky notes (never printed or exported as lyrics). */
  notes?: StickyNote[];
  /** Cover art (singles): an image id in the project's image store. */
  cover?: string;
}

export type AlbumType = 'album' | 'ep';

/** An album or EP: one project, one file, every song's lyrics together. */
export interface AlbumDoc {
  version: 1;
  type: AlbumType;
  title: string;
  artist: string;
  year: string;
  tracks: SongDoc[];
  /** Cover art: an image id in the project's image store. */
  cover?: string;
}

export const newSectionId = () => Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 7);
export const emptyLine = (): SongLine => ({ lyric: '', chords: '' });

export function emptySong(lang: SongLang): SongDoc {
  return {
    version: 1,
    title: '',
    writer: '',
    key: '',
    bpm: '',
    time: '4/4',
    capo: '',
    lang,
    sections: [{ id: newSectionId(), kind: 'verse', lines: [emptyLine()] }],
  };
}

export function emptyAlbum(type: AlbumType, lang: SongLang, title = ''): AlbumDoc {
  return { version: 1, type, title, artist: '', year: String(new Date().getFullYear()), tracks: [{ ...emptySong(lang), id: newSectionId() }] };
}

/** A song as a new album track: a deep copy with its own id. */
export const asTrack = (s: SongDoc): SongDoc => ({ ...structuredClone(s), id: newSectionId() });

/** A track taken out of its album as a single. */
export function asSingle(s: SongDoc): SongDoc {
  const { id: _id, ...rest } = structuredClone(s);
  return rest;
}

export function albumStats(a: AlbumDoc) {
  let lines = 0;
  let words = 0;
  for (const t of a.tracks) {
    const s = songStats(t);
    lines += s.lines;
    words += s.words;
  }
  return { tracks: a.tracks.length, lines, words };
}

/* ------------------------------------------------------------------ */
/* Labels and stats                                                    */
/* ------------------------------------------------------------------ */

/** The section a repeat points at (or the section itself). */
export function sourceOf(doc: SongDoc, s: SongSection): SongSection {
  if (!s.repeatOf) return s;
  return doc.sections.find((x) => x.id === s.repeatOf && !x.repeatOf) ?? s;
}

/** Lines shown for a section: its own, or those of the section it repeats. */
export const linesOf = (doc: SongDoc, s: SongSection) => sourceOf(doc, s).lines;

/**
 * "Verse 1", "Verse 2", "Chorus", "Chorus 2"… A kind is numbered when it has
 * more than one section of its own (repeats share the number of their source).
 */
export function sectionLabels(doc: SongDoc): Map<string, string> {
  const own = doc.sections.filter((s) => !s.repeatOf || sourceOf(doc, s) === s);
  const total = new Map<SectionKind, number>();
  for (const s of own) total.set(s.kind, (total.get(s.kind) ?? 0) + 1);
  const seen = new Map<SectionKind, number>();
  const labels = new Map<string, string>();
  for (const s of own) {
    const n = (seen.get(s.kind) ?? 0) + 1;
    seen.set(s.kind, n);
    labels.set(s.id, (total.get(s.kind) ?? 0) > 1 ? `${kindLabel(s.kind)} ${n}` : kindLabel(s.kind));
  }
  for (const s of doc.sections) if (!labels.has(s.id)) labels.set(s.id, labels.get(sourceOf(doc, s).id) ?? kindLabel(s.kind));
  return labels;
}

const countWords = (s: string) => s.trim().match(/\S+/g)?.length ?? 0;

/** Stats for the project list (repeats count once: they aren't written twice). */
export function songStats(doc: SongDoc) {
  let lines = 0;
  let words = 0;
  for (const s of doc.sections) {
    if (s.repeatOf && sourceOf(doc, s) !== s) continue;
    for (const l of s.lines) {
      if (l.lyric.trim()) lines++;
      words += countWords(l.lyric);
    }
  }
  return { sections: doc.sections.length, lines, words };
}

/* ------------------------------------------------------------------ */
/* Structure edits (pure: each returns a new section list)             */
/* ------------------------------------------------------------------ */

/**
 * Remove a section. Repeats of it don't disappear with it: the first one
 * becomes a real section with the lines, the others repeat that one.
 */
export function deleteSection(sections: SongSection[], id: string): SongSection[] {
  const gone = sections.find((s) => s.id === id);
  if (!gone) return sections;
  let heir: SongSection | null = null;
  const out = sections
    .filter((s) => s.id !== id)
    .map((s) => {
      if (s.repeatOf !== id) return s;
      if (!heir) {
        heir = { id: s.id, kind: gone.kind, lines: structuredClone(gone.lines) };
        return heir;
      }
      return { ...s, repeatOf: heir.id };
    });
  return out.length ? out : [{ id: newSectionId(), kind: 'verse', lines: [emptyLine()] }];
}

/** Turn a repeat into its own editable copy of the lines. */
export function unlinkRepeat(sections: SongSection[], id: string): SongSection[] {
  return sections.map((s) => {
    if (s.id !== id || !s.repeatOf) return s;
    const src = sections.find((x) => x.id === s.repeatOf);
    return { id: s.id, kind: src?.kind ?? s.kind, lines: structuredClone(src?.lines ?? [emptyLine()]) };
  });
}

/** Move a section to `to` (an index in the list without it). */
export function moveSection(sections: SongSection[], id: string, to: number): SongSection[] {
  const from = sections.findIndex((s) => s.id === id);
  if (from < 0) return sections;
  const rest = sections.filter((s) => s.id !== id);
  rest.splice(Math.max(0, Math.min(to, rest.length)), 0, sections[from]);
  return rest;
}

/**
 * Join two chord lanes when two lyric lines are merged: `b`'s chords keep
 * their columns relative to where `b`'s lyric now starts (`at`).
 */
export function joinLanes(a: string, at: number, b: string): string {
  let out = a.trimEnd();
  for (const m of b.matchAll(/\S+/g)) {
    let col = at + m.index!;
    if (out.length && col < out.length + 1) col = out.length + 1;
    out = out.padEnd(col, ' ') + m[0];
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Syllables                                                           */
/* ------------------------------------------------------------------ */

const lettersOf = (w: string) =>
  w
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');

const ID_VOWEL = /[aiueo]/;
const ID_DIPHTHONGS = new Set(['ai', 'au', 'oi', 'ei']);

/**
 * Indonesian: one syllable per vowel, except ai/au/oi/ei closing a syllable
 * (pan-tai, pu-lau, am-boi, sur-vei) — but not in ma-in, ba-ik, la-ut.
 */
export function syllablesId(word: string): number {
  const w = lettersOf(word);
  if (!w) return 0;
  let n = 0;
  for (let i = 0; i < w.length; i++) {
    if (!ID_VOWEL.test(w[i])) continue;
    n++;
    const pair = w.slice(i, i + 2);
    if (ID_DIPHTHONGS.has(pair)) {
      const rest = w.slice(i + 2);
      // Diphthong when the word ends, or a new syllable starts right after it (consonant, then vowel).
      const closes = !rest || /^(ng|ny|kh|sy|[^aiueo])[aiueo]/.test(rest);
      if (closes) i++;
    }
  }
  return Math.max(1, n);
}

/** English: the usual vowel-group estimate, with silent endings removed. */
export function syllablesEn(word: string): number {
  let w = lettersOf(word);
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, (m) => m[0]).replace(/^y/, '');
  const groups = w.match(/[aeiouy]{1,2}/g)?.length ?? 1;
  return Math.max(1, groups);
}

export function countSyllables(line: string, lang: SongLang): number {
  const count = lang === 'id' ? syllablesId : syllablesEn;
  return line
    .split(/[\s\-–—/]+/)
    .filter((w) => /\p{L}/u.test(w))
    .reduce((n, w) => n + count(w), 0);
}

/* ------------------------------------------------------------------ */
/* Rhymes                                                              */
/* ------------------------------------------------------------------ */

/**
 * The sound a line ends on: the last vowel(s) of the last word and what
 * follows. Indonesian: da-tang / pu-lang → "ang", ha-ti / ma-ti → "i".
 * English: night / light → "ight", time / rhyme → "im".
 */
export function rhymeKey(line: string, lang: SongLang): string | null {
  const words = line.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  let w = lettersOf(words[words.length - 1] ?? '');
  if (!w) return null;
  if (lang === 'en') {
    if (w.length > 3 && /[^aeiou]e$/.test(w)) w = w.slice(0, -1);
    w = w.replace(/y/g, 'i');
    return w.match(/[aeiou]+[^aeiou]*$/)?.[0] ?? w;
  }
  return w.match(/[aiueo]+[^aiueo]*$/)?.[0] ?? w;
}

/**
 * Rhyme letters for a section's lines (A, B, A, B…): lines ending on the same
 * sound share a letter. `shared` marks letters used by more than one line.
 */
export function rhymeScheme(lines: SongLine[], lang: SongLang): { letters: (string | null)[]; shared: Set<string>; scheme: string } {
  const byKey = new Map<string, string>();
  const count = new Map<string, number>();
  const letters = lines.map((l) => {
    const key = rhymeKey(l.lyric, lang);
    if (!key) return null;
    if (!byKey.has(key)) byKey.set(key, String.fromCharCode(65 + (byKey.size % 26)));
    const letter = byKey.get(key)!;
    count.set(letter, (count.get(letter) ?? 0) + 1);
    return letter;
  });
  const shared = new Set([...count].filter(([, n]) => n > 1).map(([l]) => l));
  return { letters, shared, scheme: letters.filter(Boolean).join('') };
}

/* ------------------------------------------------------------------ */
/* Chords                                                              */
/* ------------------------------------------------------------------ */

const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const NOTE_INDEX: Record<string, number> = {};
SHARPS.forEach((n, i) => (NOTE_INDEX[n] = i));
FLATS.forEach((n, i) => (NOTE_INDEX[n] = i));
Object.assign(NOTE_INDEX, { Cb: 11, 'B#': 0, Fb: 4, 'E#': 5 });

/** A chord: root, quality/extensions, optional slash bass (G, F#m7, Bb/D, Csus4, A7b9). */
const CHORD_RE = /^([A-G][#b]?)((?:maj|min|dim|aug|sus|add|m|M|\+|°|ø|\d|b|#|\(|\))*)(?:\/([A-G][#b]?))?$/;

export const isChord = (token: string) => CHORD_RE.test(token);

/** Keys written with flats (F, Bb, Eb, Dm, Gm…) keep flats when transposed. */
export function prefersFlats(key: string): boolean {
  const m = key.trim().match(/^([A-G][#b]?)(m(?!aj))?/);
  if (!m) return false;
  if (m[1].includes('b')) return true;
  if (m[1].includes('#')) return false;
  return m[2] ? ['D', 'G', 'C', 'F'].includes(m[1]) : m[1] === 'F';
}

function shiftNote(note: string, n: number, flats: boolean): string {
  const i = NOTE_INDEX[note];
  if (i === undefined) return note;
  return (flats ? FLATS : SHARPS)[(((i + n) % 12) + 12) % 12];
}

export function transposeChord(chord: string, n: number, flats: boolean): string {
  const m = chord.match(CHORD_RE);
  if (!m) return chord;
  const [, root, rest, bass] = m;
  const useFlats = flats || (root.includes('b') && !root.includes('#'));
  return shiftNote(root, n, useFlats) + rest + (bass ? '/' + shiftNote(bass, n, useFlats) : '');
}

/** Transpose every chord in a lane, keeping each at its column (later ones move right only if they'd touch). */
export function transposeLane(lane: string, n: number, flats: boolean): string {
  let out = '';
  for (const m of lane.matchAll(/\S+/g)) {
    const token = isChord(m[0]) ? transposeChord(m[0], n, flats) : m[0];
    let at = m.index!;
    if (out.length && at < out.length + 1) at = out.length + 1;
    out = out.padEnd(at, ' ') + token;
  }
  return out;
}

/** How each key is usually spelled (Bb not A#, F#m not Gbm). */
const MAJOR_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

/** Transpose a key name ("G" → "Bb", "Em" → "Gm"), spelled the usual way. */
export function transposeKey(key: string, n: number): string {
  const m = key.trim().match(/^([A-G][#b]?)(.*)$/);
  if (!m || NOTE_INDEX[m[1]] === undefined) return key;
  const minor = /^m(?!aj)/.test(m[2]);
  const i = (((NOTE_INDEX[m[1]] + n) % 12) + 12) % 12;
  return (minor ? MINOR_KEYS : MAJOR_KEYS)[i] + m[2];
}

export function transposeSong(doc: SongDoc, n: number): SongDoc {
  const key = doc.key.trim();
  // Without a key, the first chord tells which key the song is in.
  const ref = key || chordsUsed(doc)[0] || '';
  // Spell the new chords for the new key (Bb major uses flats, A major sharps).
  const flats = ref ? prefersFlats(transposeKey(ref, n)) : false;
  return {
    ...doc,
    key: key ? transposeKey(key, n) : key,
    sections: doc.sections.map((s) => ({ ...s, lines: s.lines.map((l) => ({ ...l, chords: transposeLane(l.chords, n, flats) })) })),
  };
}

/** Every chord used, in order of first appearance. */
export function chordsUsed(doc: SongDoc): string[] {
  const seen = new Set<string>();
  for (const s of doc.sections) for (const l of s.lines) for (const m of l.chords.matchAll(/\S+/g)) if (isChord(m[0])) seen.add(m[0]);
  return [...seen];
}

/* ------------------------------------------------------------------ */
/* Plain text                                                          */
/* ------------------------------------------------------------------ */

export function metaLine(doc: SongDoc, labels: { key: string; capo: string }): string {
  return [
    doc.key.trim() && `${labels.key}: ${doc.key.trim()}`,
    doc.bpm.trim() && `${doc.bpm.trim()} BPM`,
    doc.time.trim(),
    doc.capo.trim() && doc.capo.trim() !== '0' && `${labels.capo} ${doc.capo.trim()}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** A chord sheet (or just the lyrics) as plain text. */
export function songToText(doc: SongDoc, opts: { chords: boolean; byLabel: string; key: string; capo: string; untitled: string }): string {
  const out: string[] = [doc.title.trim() || opts.untitled];
  if (doc.writer.trim()) out.push(`${opts.byLabel} ${doc.writer.trim()}`);
  const meta = opts.chords ? metaLine(doc, opts) : '';
  if (meta) out.push(meta);
  const labels = sectionLabels(doc);
  for (const s of doc.sections) {
    out.push('', `[${labels.get(s.id)}]`);
    for (const l of linesOf(doc, s)) {
      if (opts.chords && l.chords.trim()) out.push(l.chords.trimEnd());
      if (l.lyric.trim() || !opts.chords || !l.chords.trim()) out.push(l.lyric.trimEnd());
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** The whole album as text: a heading with the tracklist, then every song. */
export function albumToText(
  a: AlbumDoc,
  opts: { chords: boolean; byLabel: string; key: string; capo: string; untitled: string; albumUntitled: string; typeLabel: string },
): string {
  const head = [a.title.trim() || opts.albumUntitled, [a.artist.trim(), opts.typeLabel, a.year.trim()].filter(Boolean).join(' · '), ''];
  a.tracks.forEach((t, i) => head.push(`${i + 1}. ${t.title.trim() || opts.untitled}`));
  const songs = a.tracks.map((t, i) => songToText({ ...t, title: `${i + 1}. ${t.title.trim() || opts.untitled}` }, opts));
  return [head.join('\n'), ...songs].join('\n\n' + '—'.repeat(24) + '\n\n');
}

/* ------------------------------------------------------------------ */
/* File format                                                         */
/* ------------------------------------------------------------------ */

export const SONG_FORMAT = 'terra-song';

/** Images (the cover art) travel inside the file as data URLs, by id. */
export type InlineImages = Record<string, string>;

export function serializeSong(doc: SongDoc, images?: InlineImages): string {
  return JSON.stringify(
    { format: SONG_FORMAT, version: 1, app: 'Terra Script', exportedAt: new Date().toISOString(), song: doc, ...(images && Object.keys(images).length ? { images } : {}) },
    null,
    2,
  );
}

const IMAGE_ID = /^[a-z0-9]{1,40}$/i;
/** The images that came with a .terra file (validated later, when they are stored). */
export function fileImages(raw: unknown): InlineImages {
  const imgs = raw && typeof raw === 'object' ? (raw as { images?: unknown }).images : undefined;
  if (!imgs || typeof imgs !== 'object') return {};
  return Object.fromEntries(Object.entries(imgs as Record<string, unknown>).filter(([id, v]) => IMAGE_ID.test(id) && typeof v === 'string')) as InlineImages;
}

export const isSongFile = (raw: unknown) => !!raw && typeof raw === 'object' && (raw as Record<string, unknown>).format === SONG_FORMAT;

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.replace(/\r?\n/g, ' ').slice(0, max) : '');

/** Validate untrusted data into a clean SongDoc (unknown fields are dropped). */
export function parseSong(raw: unknown): SongDoc {
  const r = (raw && typeof raw === 'object' && 'song' in raw ? (raw as { song: unknown }).song : raw) as Record<string, unknown>;
  if (!r || typeof r !== 'object' || !Array.isArray(r.sections)) throw new Error('format');
  const ids = new Set<string>();
  const sections: SongSection[] = (r.sections as Record<string, unknown>[])
    .filter((s) => s && typeof s === 'object')
    .slice(0, 500)
    .map((s) => {
      let id = str(s.id, 40);
      if (!/^[a-z0-9]+$/i.test(id) || ids.has(id)) id = newSectionId();
      ids.add(id);
      const lines = Array.isArray(s.lines)
        ? (s.lines as Record<string, unknown>[])
            .filter((l) => l && typeof l === 'object')
            .slice(0, 400)
            .map((l) => ({ lyric: str(l.lyric, 400), chords: str(l.chords, 400) }))
        : [];
      const sec: SongSection = { id, kind: KIND_SET.has(s.kind as string) ? (s.kind as SectionKind) : 'verse', lines: lines.length ? lines : [emptyLine()] };
      if (typeof s.repeatOf === 'string' && /^[a-z0-9]+$/i.test(s.repeatOf)) sec.repeatOf = s.repeatOf;
      return sec;
    });
  // A repeat must point at a real section that isn't itself a repeat.
  const own = new Set(sections.filter((s) => !s.repeatOf).map((s) => s.id));
  for (const s of sections) if (s.repeatOf && !own.has(s.repeatOf)) delete s.repeatOf;
  const coord = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-4000, Math.min(20000, Math.round(v))) : 0);
  const notes: StickyNote[] = Array.isArray(r.notes)
    ? (r.notes as Record<string, unknown>[])
        .filter((n) => n && typeof n === 'object')
        .slice(0, 200)
        .map((n) => ({
          id: typeof n.id === 'string' && /^[a-z0-9]{1,40}$/i.test(n.id) ? n.id : newSectionId(),
          x: coord(n.x),
          y: coord(n.y),
          text: typeof n.text === 'string' ? n.text.slice(0, 4000) : '',
          color: NOTE_COLORS.includes(n.color as NoteColor) ? (n.color as NoteColor) : 'yellow',
        }))
    : [];
  return {
    version: 1,
    ...(typeof r.id === 'string' && /^[a-z0-9]{1,40}$/i.test(r.id) ? { id: r.id } : {}),
    ...(notes.length ? { notes } : {}),
    ...(typeof r.cover === 'string' && IMAGE_ID.test(r.cover) ? { cover: r.cover } : {}),
    title: str(r.title),
    writer: str(r.writer),
    key: str(r.key, 12),
    bpm: str(r.bpm, 8),
    time: str(r.time, 8),
    capo: str(r.capo, 4),
    lang: r.lang === 'en' ? 'en' : 'id',
    sections: sections.length ? sections : [{ id: newSectionId(), kind: 'verse', lines: [emptyLine()] }],
  };
}

export const ALBUM_FORMAT = 'terra-album';

export function serializeAlbum(a: AlbumDoc, images?: InlineImages): string {
  return JSON.stringify(
    { format: ALBUM_FORMAT, version: 1, app: 'Terra Script', exportedAt: new Date().toISOString(), album: a, ...(images && Object.keys(images).length ? { images } : {}) },
    null,
    2,
  );
}

export const isAlbumFile = (raw: unknown) => !!raw && typeof raw === 'object' && (raw as Record<string, unknown>).format === ALBUM_FORMAT;

export function parseAlbum(raw: unknown): AlbumDoc {
  const r = (raw && typeof raw === 'object' && 'album' in raw ? (raw as { album: unknown }).album : raw) as Record<string, unknown>;
  if (!r || typeof r !== 'object' || !Array.isArray(r.tracks)) throw new Error('format');
  const ids = new Set<string>();
  const tracks = (r.tracks as unknown[]).slice(0, 200).map((t) => {
    const s = parseSong(t);
    if (!s.id || ids.has(s.id)) s.id = newSectionId();
    ids.add(s.id);
    return s;
  });
  return {
    version: 1,
    type: r.type === 'ep' ? 'ep' : 'album',
    title: str(r.title),
    artist: str(r.artist),
    year: str(r.year, 12),
    tracks: tracks.length ? tracks : [{ ...emptySong('id'), id: newSectionId() }],
    ...(typeof r.cover === 'string' && IMAGE_ID.test(r.cover) ? { cover: r.cover } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Sample                                                              */
/* ------------------------------------------------------------------ */

const L = (chords: string, lyric: string): SongLine => ({ chords, lyric });

export function sampleSong(lang: SongLang): SongDoc {
  const chorusId = newSectionId();
  if (lang === 'id') {
    return {
      version: 1,
      title: 'Lampu Kota',
      writer: 'Terra Script',
      key: 'G',
      bpm: '92',
      time: '4/4',
      capo: '',
      lang: 'id',
      sections: [
        { id: newSectionId(), kind: 'intro', lines: [L('G       D       Em      C', '')] },
        {
          id: newSectionId(),
          kind: 'verse',
          lines: [
            L('G                D', 'Jalan basah sisa hujan sore'),
            L('Em               C', 'Kau tertawa di bawah lampu kota'),
            L('G                D', 'Langkah kita pelan tak terburu'),
            L('Em          C', 'Seakan malam milik kita'),
          ],
        },
        {
          id: chorusId,
          kind: 'chorus',
          lines: [
            L('C           G', 'Jangan pulang dulu'),
            L('D              Em', 'Biar waktu yang menunggu'),
            L('C            G', 'Satu lagu lagi'),
            L('D                G', 'Sebelum pagi datang lagi'),
          ],
        },
        {
          id: newSectionId(),
          kind: 'verse',
          lines: [
            L('G                 D', 'Kopi dingin di meja sudut'),
            L('Em              C', 'Cerita lama kita ulang'),
            L('G               D', 'Tak ada yang perlu disebut'),
            L('Em           C', 'Semua sudah terang'),
          ],
        },
        { id: newSectionId(), kind: 'chorus', repeatOf: chorusId, lines: [emptyLine()] },
        { id: newSectionId(), kind: 'outro', lines: [L('C       D       G', 'Satu lagu lagi')] },
      ],
    };
  }
  return {
    version: 1,
    title: 'City Lights',
    writer: 'Terra Script',
    key: 'G',
    bpm: '92',
    time: '4/4',
    capo: '',
    lang: 'en',
    sections: [
      { id: newSectionId(), kind: 'intro', lines: [L('G       D       Em      C', '')] },
      {
        id: newSectionId(),
        kind: 'verse',
        lines: [
          L('G               D', 'Streets still shine from evening rain'),
          L('Em              C', 'You laugh beneath the city light'),
          L('G             D', "We're walking slow, no need to run"),
          L('Em          C', 'Like we own the night'),
        ],
      },
      {
        id: chorusId,
        kind: 'chorus',
        lines: [
          L('C          G', "Don't go home yet"),
          L('D              Em', 'Let the hours wait for us'),
          L('C           G', 'One more song'),
          L('D              G', 'Before the morning comes'),
        ],
      },
      {
        id: newSectionId(),
        kind: 'verse',
        lines: [
          L('G              D', 'Coffee cold on the corner table'),
          L('Em            C', 'Old stories told again'),
          L('G                D', "Nothing left we're not able"),
          L('Em          C', 'To say out loud, my friend'),
        ],
      },
      { id: newSectionId(), kind: 'chorus', repeatOf: chorusId, lines: [emptyLine()] },
      { id: newSectionId(), kind: 'outro', lines: [L('C       D       G', 'One more song')] },
    ],
  };
}
