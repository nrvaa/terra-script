/**
 * Song editor: sections of lyric lines, each with a chord lane above it in the
 * same monospaced font. Syllables and rhymes are counted as you type.
 * The song is kept in `doc`; the sheet is re-rendered after structural edits,
 * typing only updates the counts around it.
 */
import { applyI18n, getLang, setLang, t, type Key, type Lang } from './i18n';
import { saveFile } from './save-file';
import {
  addSongsToAlbum,
  createAlbum,
  createSong,
  getImage,
  imagesAsDataUrls,
  importFile,
  loadAlbum,
  loadSong,
  markBackedUp,
  putImage,
  saveAlbum,
  saveSong,
  songUrl,
} from './projects';
import { hideLoader, initThemeSwitches, syncThemeSwitches, themeTransition } from './ui-effects';
import { initDesktopPromo } from './desktop-promo';
import { chooseNewKind, pickAlbumFor, pickSingles } from './music-dialogs';
import { drawMockup, loadImage, prepareCover, type MockupBg, type MockupKind } from './cover-mockup';
import {
  NEXT_SECTION,
  NOTE_COLORS,
  SECTION_KINDS,
  albumToText,
  asSingle,
  emptyAlbum,
  emptySong,
  serializeAlbum,
  type AlbumDoc,
  type NoteColor,
  type StickyNote,
  chordsUsed,
  countSyllables,
  deleteSection,
  emptyLine,
  joinLanes,
  linesOf,
  metaLine,
  moveSection,
  newSectionId,
  rhymeScheme,
  sectionLabels,
  serializeSong,
  songStats,
  songToText,
  sourceOf,
  transposeSong,
  unlinkRepeat,
  type SectionKind,
  type SongDoc,
  type SongLine,
  type SongSection,
} from './song';

/* -------------------------------------------------------------------- */
/* Settings, theme, language                                             */
/* -------------------------------------------------------------------- */

const SETTINGS_KEY = 'tewrite:settings';
const UNSAVED_PREFIX = 'tewrite:unsaved:';
function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}
function writeSettings(patch: Record<string, unknown>) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readSettings(), ...patch }));
  } catch {
    /* ignore */
  }
}
const settings = readSettings();
setLang((settings.lang as Lang) || 'en');
const paper = settings.paper === 'a4' ? 'a4' : 'letter';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

initThemeSwitches((dark, source) =>
  themeTransition(() => {
    document.documentElement.classList.toggle('dark', dark);
    writeSettings({ theme: dark ? 'dark' : 'light' });
    syncThemeSwitches();
  }, source),
);

const projectId = new URLSearchParams(location.search).get('p');
/** The song being edited: the single, or the open track of an album. */
let doc: SongDoc;
/** Set when the project is an album / EP; `doc` is then album.tracks[trackIdx]. */
let album: AlbumDoc | null = null;
let trackIdx = 0;
let showChords = settings.songChords !== false;
let showNotes = settings.songNotes !== false;
let zoom = typeof settings.songZoom === 'number' ? Math.min(1.6, Math.max(0.7, settings.songZoom as number)) : 1;

/** Keep the album pointing at the current song (undo and transpose replace `doc`). */
const writeBack = () => {
  // trackIdx is -1 while switching after a track was removed: nothing to write then.
  if (album && trackIdx >= 0 && trackIdx < album.tracks.length) album.tracks[trackIdx] = doc;
};

/** Every sheet on the desk: one song, or (albums in scroll mode) every song, one paper each. */
const stage = $('#sg-stage');
const desk = $('main.sg-desk');
/** The sheet, paper and sticky-note layer of the song being edited (`doc`). */
let sheet!: HTMLElement;
let paperEl!: HTMLElement;
let notesEl!: HTMLElement;
/** Albums: all songs on one long scroll (true), or one song at a time. */
let songScroll = settings.songScroll !== false;
const scrollMode = () => !!album && songScroll;
/** The header field: the album's title in an album, the song's title in a single. */
const titleInput = $<HTMLInputElement>('#song-title');

/* -------------------------------------------------------------------- */
/* Focus: where the caret is, so it survives re-rendering and undo       */
/* -------------------------------------------------------------------- */

type Field = 'lyric' | 'chords';
interface Focus {
  sec: string;
  line: number;
  field: Field;
  caret: number;
}
let focus: Focus | null = null;

function fieldEl(f: Pick<Focus, 'sec' | 'line' | 'field'>): HTMLInputElement | null {
  return sheet.querySelector<HTMLInputElement>(`[data-sec="${f.sec}"] [data-line="${f.line}"] [data-f="${f.field}"]`);
}

function focusField(f: Focus) {
  if (f.field === 'chords' && !showChords) f = { ...f, field: 'lyric' };
  const el = fieldEl(f);
  if (!el) return;
  // A chord lane is a ruler: reaching past its end adds spaces, so a chord can go over any syllable.
  if (f.field === 'chords' && el.value.length < f.caret) {
    el.value = el.value.padEnd(f.caret, ' ');
    lineAt(f.sec, f.line)!.chords = el.value;
  }
  el.focus({ preventScroll: true });
  const c = Math.min(f.caret, el.value.length);
  el.setSelectionRange(c, c);
  syncScroll(el);
  el.closest('.sg-line')?.scrollIntoView({ block: 'nearest' });
  focus = { ...f, caret: c };
}

function readFocus(el: Element | null): Focus | null {
  const input = el instanceof HTMLInputElement && el.dataset.f ? el : null;
  if (!input) return null;
  const sec = input.closest<HTMLElement>('[data-sec]')?.dataset.sec;
  const line = Number(input.closest<HTMLElement>('[data-line]')?.dataset.line);
  if (!sec || Number.isNaN(line)) return null;
  return { sec, line, field: input.dataset.f as Field, caret: input.selectionStart ?? 0 };
}

const section = (id: string) => doc.sections.find((s) => s.id === id);
const lineAt = (sec: string, i: number): SongLine | undefined => section(sec)?.lines[i];

/* -------------------------------------------------------------------- */
/* History                                                               */
/* -------------------------------------------------------------------- */

let history: { doc: string; focus: Focus | null }[] = [];
let hIndex = -1;
let typingTimer: number | undefined;

function commit() {
  window.clearTimeout(typingTimer);
  typingTimer = undefined;
  const snap = JSON.stringify(doc);
  if (history[hIndex]?.doc === snap) {
    history[hIndex].focus = focus;
    return;
  }
  history = history.slice(0, hIndex + 1);
  history.push({ doc: snap, focus });
  if (history.length > 300) history.shift();
  hIndex = history.length - 1;
  scheduleSave();
}

function typed() {
  window.clearTimeout(typingTimer);
  typingTimer = window.setTimeout(commit, 600);
  scheduleSave();
}

const flushTyping = () => typingTimer !== undefined && commit();

function restore(i: number) {
  hIndex = i;
  doc = JSON.parse(history[i].doc);
  writeBack();
  render();
  if (history[i].focus) focusField(history[i].focus!);
  scheduleSave();
}
function undo() {
  flushTyping();
  if (hIndex > 0) restore(hIndex - 1);
}
function redo() {
  flushTyping();
  if (hIndex < history.length - 1) restore(hIndex + 1);
}

/** Apply a structural change: commit, re-render, put the caret somewhere sensible. */
function change(fn: () => void, then?: Focus | null) {
  flushTyping();
  fn();
  if (then !== undefined) focus = then;
  render();
  if (focus) focusField(focus);
  commit();
}

/* -------------------------------------------------------------------- */
/* Saving                                                                */
/* -------------------------------------------------------------------- */

let saveTimer: number | undefined;
let dirty = false;
let saveFailed = false;
const saveStatus = $('#save-status');

function scheduleSave() {
  dirty = true;
  saveStatus.textContent = t('save.saving');
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 500);
}

async function saveNow() {
  window.clearTimeout(saveTimer);
  if (!projectId || !doc) return;
  dirty = false;
  try {
    writeBack();
    if (album) await saveAlbum(projectId, album);
    else await saveSong(projectId, doc);
    saveFailed = false;
    saveStatus.textContent = t('save.saved', { time: new Date().toLocaleTimeString(getLang() === 'id' ? 'id-ID' : 'en-US', { hour: '2-digit', minute: '2-digit' }) });
  } catch (err) {
    console.error(err);
    saveFailed = true;
    saveStatus.textContent = t('save.failed');
  }
}

// The page may close before IndexedDB finishes: keep a synchronous copy for next time.
function keepUnsaved() {
  if (!projectId || !doc || (!dirty && !saveFailed)) return;
  writeBack();
  try {
    localStorage.setItem(UNSAVED_PREFIX + projectId, JSON.stringify(album ? { at: Date.now(), album } : { at: Date.now(), song: doc }));
  } catch {
    /* ignore */
  }
  void saveNow();
}
window.addEventListener('pagehide', keepUnsaved);
window.addEventListener('beforeunload', keepUnsaved);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && keepUnsaved());

function takeUnsaved(newerThan: number): { song?: SongDoc; album?: AlbumDoc } | null {
  if (!projectId) return null;
  try {
    const raw = localStorage.getItem(UNSAVED_PREFIX + projectId);
    if (!raw) return null;
    localStorage.removeItem(UNSAVED_PREFIX + projectId);
    const { at, song, album: a } = JSON.parse(raw) as { at: number; song?: SongDoc; album?: AlbumDoc };
    if (at <= newerThan) return null;
    if (Array.isArray(song?.sections)) return { song };
    if (Array.isArray(a?.tracks) && a.tracks.length) return { album: a };
    return null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------- */
/* Rendering                                                             */
/* -------------------------------------------------------------------- */

const ICONS = {
  grip: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>',
  unlink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  goto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
};

const btn = (act: string, icon: string, label: string) =>
  `<button type="button" class="sg-sec-btn" data-sec-act="${act}" title="${esc(label)}" aria-label="${esc(label)}">${icon}</button>`;

function lineHtml(l: SongLine, i: number, n: number): string {
  const nth = t('song.lineN', { n: i + 1 });
  return `<div class="sg-line" data-line="${i}">
    <input class="sg-chords" data-f="chords" value="${esc(l.chords)}" placeholder="${esc(i === 0 ? t('song.chordPh') : '')}" spellcheck="false" autocomplete="off" aria-label="${esc(t('song.chordsOf', { line: nth }))}">
    <div class="sg-lyric-row">
      <input class="sg-lyric" data-f="lyric" value="${esc(l.lyric)}" placeholder="${esc(n === 1 ? t('song.lyricPh') : '')}" spellcheck="false" autocomplete="off" aria-label="${esc(nth)}">
      <span class="sg-syl" data-syl></span>
      <span class="sg-rhyme" data-rhyme></span>
    </div>
  </div>`;
}

/** A repeat shows the lines it repeats, read-only. */
function repeatHtml(lines: SongLine[]): string {
  return lines
    .map(
      (l) => `<div class="sg-line is-ro">
        ${l.chords.trim() ? `<div class="sg-ro sg-ro-chords">${esc(l.chords)}</div>` : ''}
        <div class="sg-ro">${esc(l.lyric) || '&nbsp;'}</div>
      </div>`,
    )
    .join('');
}

function sectionHtml(s: SongSection, label: string, index: number): string {
  const src = sourceOf(doc, s);
  const repeat = src !== s;
  const kind = src.kind;
  const options = SECTION_KINDS.map((k) => `<option value="${k.kind}"${k.kind === kind ? ' selected' : ''}>${k.label}</option>`).join('');
  const n = doc.sections.length;
  return `<section class="sg-sec${repeat ? ' is-repeat' : ''}" data-sec="${s.id}" data-kind="${kind}" aria-label="${esc(label)}">
    <header class="sg-head">
      <span class="sg-grip" draggable="true" data-drag title="${esc(t('song.drag'))}">${ICONS.grip}</span>
      <h3 class="sg-label">${esc(label)}</h3>
      ${repeat ? `<span class="sg-tag">${esc(t('song.repeatTag'))}</span>` : `<select class="sg-kind" data-kind-select aria-label="${esc(t('song.kind'))}">${options}</select>`}
      <span class="sg-scheme" data-scheme title="${esc(t('song.schemeTip'))}"></span>
      <span class="sg-sec-actions">
        ${index > 0 ? btn('up', ICONS.up, t('song.moveUp')) : ''}
        ${index < n - 1 ? btn('down', ICONS.down, t('song.moveDown')) : ''}
        ${repeat ? btn('goto', ICONS.goto, t('song.gotoSource')) + btn('unlink', ICONS.unlink, t('song.unlink')) : btn('dup', ICONS.copy, t('song.duplicate')) + btn('repeat', ICONS.repeat, t('song.repeatThis'))}
        ${btn('del', ICONS.del, t('song.delete'))}
      </span>
    </header>
    <div class="sg-lines">${repeat ? repeatHtml(src.lines) : s.lines.map((l, i) => lineHtml(l, i, s.lines.length)).join('')}</div>
  </section>`;
}

/* -------------------------------------------------------------------- */
/* Papers: one per song on the desk                                      */
/* -------------------------------------------------------------------- */

const trackDoc = (i: number): SongDoc => (album ? album.tracks[i] : doc);
/** Which songs get a paper: every track in scroll mode, else just the one being edited. */
const paperIndices = (): number[] => (album ? (scrollMode() ? album.tracks.map((_, i) => i) : [trackIdx]) : [0]);

/** A paper: the song's title at the top, its sheet, its sticky notes. */
function paperHtml(i: number): string {
  const s = trackDoc(i);
  const no = album ? `<span class="sg-track-no" title="${esc(t('mus.trackN', { n: i + 1 }))}">${i + 1}</span>` : '';
  return `<article class="sg-paper" data-paper="${i}">
    <header class="sg-paper-head">${no}
      <input class="sg-song-title" data-song-title value="${esc(s.title)}" placeholder="${esc(t('song.titlePh'))}" aria-label="${esc(t('song.titlePh'))}" autocomplete="off" spellcheck="false">
    </header>
    <div class="sg-sheet" data-sheet></div>
    <div class="sg-notes" data-notes></div>
  </article>`;
}

function useRefs(i: number) {
  paperEl = stage.querySelector<HTMLElement>(`[data-paper="${i}"]`)!;
  sheet = paperEl.querySelector<HTMLElement>('[data-sheet]')!;
  notesEl = paperEl.querySelector<HTMLElement>('[data-notes]')!;
}

/** Run `fn` as if song `i` were the one being edited (used to draw the other papers). */
function withTrack(i: number, fn: () => void) {
  const saved = { doc, trackIdx };
  doc = trackDoc(i);
  trackIdx = i;
  useRefs(i);
  try {
    fn();
  } finally {
    doc = saved.doc;
    trackIdx = saved.trackIdx;
    useRefs(album ? trackIdx : 0);
  }
}

/** (Re)build every paper on the desk, then draw the current song last so the panels show it. */
function buildPapers() {
  writeBack();
  stage.innerHTML = paperIndices().map(paperHtml).join('');
  for (const i of paperIndices()) if (album && i !== trackIdx) withTrack(i, renderSheet);
  useRefs(album ? trackIdx : 0);
  render();
}

/** Make song `i` the one being edited (its own undo history), without redrawing anything. */
function activateTrack(i: number) {
  if (!album || i === trackIdx || !album.tracks[i]) return;
  flushTyping();
  writeBack();
  trackIdx = i;
  doc = album.tracks[i];
  useRefs(i);
  history = [];
  hIndex = -1;
  focus = null;
  commit();
  renderChrome();
  updateCounts();
  const params = new URLSearchParams(location.search);
  params.set('t', doc.id ?? '');
  window.history.replaceState(null, '', `${location.pathname}?${params}`);
}

/** Events from another paper first make that song the current one. */
function ensureActive(target: EventTarget | null) {
  const p = (target as Element | null)?.closest?.<HTMLElement>('[data-paper]');
  if (p && album) activateTrack(Number(p.dataset.paper));
}

/** The paper nearest to a point on the desk (for notes dropped in the margins). */
function paperAt(y: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let dist = Infinity;
  for (const p of stage.querySelectorAll<HTMLElement>('[data-paper]')) {
    const r = p.getBoundingClientRect();
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < dist) [best, dist] = [p, d];
  }
  return best;
}

/** The current song's sheet, counts and notes. */
function renderSheet() {
  const labels = sectionLabels(doc);
  sheet.innerHTML = doc.sections.map((s, i) => sectionHtml(s, labels.get(s.id)!, i)).join('');
  const title = paperEl.querySelector<HTMLInputElement>('[data-song-title]');
  if (title && document.activeElement !== title) title.value = doc.title;
  updateCounts();
  renderNotes();
}

/** Everything around the sheets: header, details, album panel, chords and zoom. */
function renderChrome() {
  if (document.activeElement !== titleInput) titleInput.value = album ? album.title : doc.title;
  titleInput.placeholder = t(album ? 'mus.albumTitle' : 'song.titlePh');
  titleInput.setAttribute('aria-label', titleInput.placeholder);
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-meta]')) {
    const k = el.dataset.meta as 'writer' | 'key' | 'bpm' | 'time' | 'capo' | 'lang';
    if (document.activeElement !== el) el.value = doc[k];
  }
  stage.classList.toggle('no-chords', !showChords);
  stage.classList.toggle('is-scroll', scrollMode());
  stage.style.setProperty('--sg-zoom', String(zoom));
  document.title = `${(album ? album.title : doc.title).trim() || t(album ? 'mus.albumUntitled' : 'song.untitled')} — Terra Script`;
  renderAlbum();
  syncCover();
}

function render() {
  renderSheet();
  renderChrome();
}

const RHYME_COLORS = 6;

/** Syllables, rhymes, schemes, side panel and status bar (cheap: runs on every keystroke). */
function updateCounts() {
  const labels = sectionLabels(doc);
  for (const s of doc.sections) {
    const el = sheet.querySelector<HTMLElement>(`[data-sec="${s.id}"]`);
    if (!el) continue;
    const lines = linesOf(doc, s);
    const { letters, shared, scheme } = rhymeScheme(lines, doc.lang);
    const sharedList = [...shared];
    el.querySelector('[data-scheme]')!.textContent = scheme.length > 1 ? scheme : '';
    if (sourceOf(doc, s) !== s) {
      el.querySelector('.sg-lines')!.innerHTML = repeatHtml(lines);
      continue;
    }
    lines.forEach((l, i) => {
      const row = el.querySelector(`[data-line="${i}"]`);
      if (!row) return;
      const syl = countSyllables(l.lyric, doc.lang);
      row.querySelector('[data-syl]')!.textContent = syl ? String(syl) : '';
      const r = row.querySelector<HTMLElement>('[data-rhyme]')!;
      const letter = letters[i];
      r.textContent = letter ?? '';
      if (letter && shared.has(letter)) r.dataset.c = String(sharedList.indexOf(letter) % RHYME_COLORS);
      else delete r.dataset.c;
    });
  }
  renderSide(labels);
  renderStatus(labels);
  // Line counts in the tracklist follow the typing (not while a track is being dragged).
  if (album && dragTrack < 0) renderTracks();
}

function renderSide(labels: Map<string, string>) {
  $('#sg-structure').innerHTML = doc.sections
    .map((s) => {
      const src = sourceOf(doc, s);
      const n = src.lines.filter((l) => l.lyric.trim()).length;
      return `<li draggable="true" data-goto="${s.id}" data-kind="${src.kind}" class="${src !== s ? 'is-repeat' : ''}${focus?.sec === s.id ? ' is-current' : ''}">
        <i class="sg-dot" aria-hidden="true"></i><span class="sg-st-label">${esc(labels.get(s.id)!)}</span>
        ${src !== s ? `<span class="sg-st-rep" title="${esc(t('song.repeatTag'))}">↻</span>` : ''}<span class="sg-st-n">${n}</span></li>`;
    })
    .join('');
  const chords = chordsUsed(doc);
  $('#sg-chord-list').innerHTML = chords.length
    ? chords.map((c) => `<span class="sg-chip">${esc(c)}</span>`).join('')
    : `<p class="text-muted text-xs">${esc(t('song.noChords'))}</p>`;
  const st = songStats(doc);
  const syl = doc.sections.reduce((n, s) => n + linesOf(doc, s).reduce((m, l) => m + countSyllables(l.lyric, doc.lang), 0), 0);
  $('#sg-stats').innerHTML = [
    [t('song.statSections'), st.sections],
    [t('song.statLines'), st.lines],
    [t('song.statWords'), st.words],
    [t('song.statSyllables'), syl],
    [t('song.statChords'), chords.length],
  ]
    .map(([k, v]) => `<div><dt>${esc(String(k))}</dt><dd>${v}</dd></div>`)
    .join('');
  $('#sg-key-view').textContent = doc.key.trim() || '—';
}

function renderStatus(labels: Map<string, string>) {
  const s = focus && section(focus.sec);
  const l = s && focus ? s.lines[focus.line] : undefined;
  $('#st-section').innerHTML = s ? `<b>${esc(labels.get(s.id)!)}</b> · ${esc(t('song.lineN', { n: focus!.line + 1 }))}` : '';
  $('#st-syl').textContent = l ? t('song.sylCount', { n: countSyllables(l.lyric, doc.lang) }) : '';
  const scheme = s ? rhymeScheme(s.lines, doc.lang).scheme : '';
  $('#st-scheme').textContent = scheme.length > 1 ? t('song.schemeIs', { s: scheme }) : '';
  $('#st-words').textContent = t('song.wordCount', { n: songStats(doc).words });
}

/* -------------------------------------------------------------------- */
/* Structure                                                             */
/* -------------------------------------------------------------------- */

const firstLine = (sec: string): Focus => ({ sec, line: 0, field: 'lyric', caret: 0 });
const currentIndex = () => (focus ? doc.sections.findIndex((s) => s.id === focus!.sec) : doc.sections.length - 1);

function addSection(kind: SectionKind, at = currentIndex() + 1) {
  const s: SongSection = { id: newSectionId(), kind, lines: [emptyLine()] };
  change(() => doc.sections.splice(at, 0, s), firstLine(s.id));
}

/** Repeat a section (its source if it is a repeat itself) right after the current one. */
function addRepeat(of: SongSection) {
  const src = sourceOf(doc, of);
  const s: SongSection = { id: newSectionId(), kind: src.kind, repeatOf: src.id, lines: [emptyLine()] };
  const at = currentIndex() + 1;
  change(() => doc.sections.splice(at, 0, s), null);
  sheet.querySelector(`[data-sec="${s.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  toast(t('song.repeated', { name: sectionLabels(doc).get(src.id)! }));
}

function repeatChorus() {
  // The chorus nearest above the cursor, else the first one, else the current section.
  const at = Math.max(0, currentIndex());
  const own = doc.sections.filter((s) => sourceOf(doc, s) === s);
  const choruses = own.filter((s) => s.kind === 'chorus');
  const above = [...doc.sections.slice(0, at + 1)].reverse().find((s) => sourceOf(doc, s).kind === 'chorus');
  const pick = above ? sourceOf(doc, above) : choruses[0] ?? doc.sections[at];
  if (!pick) return;
  addRepeat(pick);
}

function sectionAction(act: string, id: string) {
  const i = doc.sections.findIndex((s) => s.id === id);
  const s = doc.sections[i];
  if (!s) return;
  const keep = focus?.sec === id ? focus : null;
  if (act === 'up') change(() => (doc.sections = moveSection(doc.sections, id, i - 1)), keep);
  else if (act === 'down') change(() => (doc.sections = moveSection(doc.sections, id, i + 1)), keep);
  else if (act === 'dup') {
    const copy: SongSection = { id: newSectionId(), kind: s.kind, lines: structuredClone(s.lines) };
    change(() => doc.sections.splice(i + 1, 0, copy), firstLine(copy.id));
  } else if (act === 'repeat') {
    focus = { ...firstLine(id) };
    addRepeat(s);
  } else if (act === 'unlink') change(() => (doc.sections = unlinkRepeat(doc.sections, id)), firstLine(id));
  else if (act === 'goto') {
    const src = sourceOf(doc, s);
    focusField(firstLine(src.id));
    sheet.querySelector(`[data-sec="${src.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } else if (act === 'del') {
    const hasText = sourceOf(doc, s) === s && s.lines.some((l) => l.lyric.trim() || l.chords.trim());
    if (hasText && !confirm(t('song.confirmDelete', { name: sectionLabels(doc).get(id)! }))) return;
    const next = doc.sections[i + 1] ?? doc.sections[i - 1];
    change(() => (doc.sections = deleteSection(doc.sections, id)), next && next.id !== id ? firstLine(next.id) : null);
  }
}

/* -------------------------------------------------------------------- */
/* Lines and keys                                                        */
/* -------------------------------------------------------------------- */

/** Editable lines in reading order (repeats are skipped). */
function allPositions(): { sec: string; line: number }[] {
  const out: { sec: string; line: number }[] = [];
  for (const s of doc.sections) if (sourceOf(doc, s) === s) s.lines.forEach((_, i) => out.push({ sec: s.id, line: i }));
  return out;
}

function neighbour(f: Focus, dir: 1 | -1): { sec: string; line: number } | null {
  const all = allPositions();
  const k = all.findIndex((p) => p.sec === f.sec && p.line === f.line);
  return all[k + dir] ?? null;
}

function moveVertical(f: Focus, dir: 1 | -1) {
  // Reading order: chord lane, lyric, chord lane, lyric…
  if (showChords && dir === -1 && f.field === 'lyric') return focusField({ ...f, field: 'chords' });
  if (showChords && dir === 1 && f.field === 'chords') return focusField({ ...f, field: 'lyric' });
  const n = neighbour(f, dir);
  if (n) return focusField({ ...n, field: dir === 1 && showChords ? 'chords' : 'lyric', caret: f.caret });
  // Scroll mode: past the last line of a song, carry on into the next one (and back).
  if (!scrollMode() || !album?.tracks[trackIdx + dir]) return;
  activateTrack(trackIdx + dir);
  const all = allPositions();
  const to = dir === 1 ? all[0] : all[all.length - 1];
  if (to) focusField({ ...to, field: dir === 1 && showChords ? 'chords' : 'lyric', caret: f.caret });
}

function onKeyDown(e: KeyboardEvent) {
  const el = e.target as HTMLInputElement;
  const f = readFocus(el);
  if (!f || e.isComposing) return;
  const s = section(f.sec)!;
  const l = s.lines[f.line];
  const mod = e.ctrlKey || e.metaKey;
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  const collapsed = start === end;

  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    if (e.altKey && !mod) {
      // Move the line within its section.
      e.preventDefault();
      const to = f.line + dir;
      if (to < 0 || to >= s.lines.length) return;
      change(() => ([s.lines[f.line], s.lines[to]] = [s.lines[to], s.lines[f.line]]), { ...f, line: to, caret: start });
      return;
    }
    if (mod || e.shiftKey) return;
    e.preventDefault();
    moveVertical({ ...f, caret: start }, dir);
    return;
  }

  if (e.key === 'Tab' && !mod && !e.altKey) {
    // Hop between the lyric and its chord lane at the same column.
    e.preventDefault();
    if (!showChords) setChords(true);
    focusField({ ...f, field: f.field === 'lyric' ? 'chords' : 'lyric', caret: start });
    return;
  }

  if (f.field === 'chords') {
    if (e.key === 'Enter') {
      e.preventDefault();
      focusField({ ...f, field: 'lyric', caret: start });
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && !mod) {
      // Clearing a chord leaves spaces, so the chords after it stay over their syllables.
      e.preventDefault();
      let a = start;
      let b = end;
      if (collapsed) {
        if (e.key === 'Backspace') a = Math.max(0, a - 1);
        else b = Math.min(el.value.length, b + 1);
      }
      if (a === b) return;
      let v = el.value.slice(0, a) + ' '.repeat(b - a) + el.value.slice(b);
      // Nothing after the cleared part: drop the spaces instead.
      if (b >= el.value.length) v = v.trimEnd();
      el.value = v;
      el.setSelectionRange(a, a);
      onFieldInput(el);
    }
    return;
  }

  // Lyric line
  if (e.key === 'Enter' && !mod) {
    e.preventDefault();
    const last = f.line === s.lines.length - 1;
    if (!l.lyric.trim() && !l.chords.trim() && last && s.lines.length > 1) {
      // An empty last line ends the section: start the one that usually follows.
      const kind = NEXT_SECTION[s.kind];
      const next: SongSection = { id: newSectionId(), kind, lines: [emptyLine()] };
      const at = doc.sections.indexOf(s) + 1;
      change(() => {
        s.lines.pop();
        doc.sections.splice(at, 0, next);
      }, firstLine(next.id));
      return;
    }
    // Split the line at the caret; chords after the caret go with the text.
    const head: SongLine = { lyric: l.lyric.slice(0, start), chords: l.chords.slice(0, start).trimEnd() };
    const tail: SongLine = { lyric: l.lyric.slice(end), chords: l.chords.slice(end) };
    change(() => s.lines.splice(f.line, 1, head, tail), { ...f, line: f.line + 1, caret: 0 });
    return;
  }

  if (e.key === 'Backspace' && collapsed && start === 0 && !mod) {
    if (f.line > 0) {
      e.preventDefault();
      const prev = s.lines[f.line - 1];
      const at = prev.lyric.length;
      change(
        () => {
          s.lines.splice(f.line - 1, 2, { lyric: prev.lyric + l.lyric, chords: joinLanes(prev.chords, at, l.chords) });
        },
        { ...f, line: f.line - 1, caret: at },
      );
    } else if (s.lines.length === 1 && !l.lyric && !l.chords.trim() && doc.sections.length > 1) {
      // Backspace in an empty section removes it.
      e.preventDefault();
      const i = doc.sections.indexOf(s);
      const prev = doc.sections.slice(0, i).reverse().find((x) => sourceOf(doc, x) === x);
      change(
        () => (doc.sections = deleteSection(doc.sections, s.id)),
        prev ? { sec: prev.id, line: prev.lines.length - 1, field: 'lyric', caret: prev.lines[prev.lines.length - 1].lyric.length } : null,
      );
    }
    return;
  }

  if (e.key === 'Delete' && collapsed && start === el.value.length && !mod && f.line < s.lines.length - 1) {
    e.preventDefault();
    const next = s.lines[f.line + 1];
    const at = l.lyric.length;
    change(() => s.lines.splice(f.line, 2, { lyric: l.lyric + next.lyric, chords: joinLanes(l.chords, at, next.chords) }), { ...f, caret: at });
  }
}

/** Typing chords overwrites the spaces ahead instead of pushing later chords right. */
function onBeforeInput(e: InputEvent) {
  const el = e.target as HTMLInputElement;
  if (el.dataset.f !== 'chords' || e.inputType !== 'insertText' || !e.data || e.isComposing) return;
  const a = el.selectionStart ?? 0;
  const b = el.selectionEnd ?? 0;
  const n = e.data.length;
  const ahead = el.value.slice(b, b + n);
  if (a !== b || ahead.length < n || ahead.trim()) return;
  e.preventDefault();
  el.value = el.value.slice(0, a) + e.data + el.value.slice(a + n);
  el.setSelectionRange(a + n, a + n);
  onFieldInput(el);
}

function onFieldInput(el: HTMLInputElement) {
  const f = readFocus(el);
  if (!f) return;
  const l = lineAt(f.sec, f.line);
  if (!l) return;
  l[f.field] = el.value;
  focus = f;
  syncScroll(el);
  updateCounts();
  typed();
}

/** The chord lane and its lyric scroll together, so columns stay lined up. */
function syncScroll(el: HTMLInputElement) {
  const row = el.closest('.sg-line');
  if (!row) return;
  const other = row.querySelector<HTMLInputElement>(el.dataset.f === 'lyric' ? '[data-f="chords"]' : '[data-f="lyric"]');
  if (other && other.scrollLeft !== el.scrollLeft) other.scrollLeft = el.scrollLeft;
}

stage.addEventListener('keydown', onKeyDown);
stage.addEventListener('beforeinput', (e) => onBeforeInput(e as InputEvent));
stage.addEventListener('input', (e) => {
  // The song title at the top of the paper.
  const st = e.target as HTMLInputElement;
  if (st.matches?.('[data-song-title]')) {
    ensureActive(st);
    doc.title = st.value;
    if (!album) titleInput.value = st.value;
    renderChrome();
    typed();
    return;
  }
  const el = e.target as HTMLElement;
  if (el instanceof HTMLInputElement && el.dataset.f) onFieldInput(el);
});
stage.addEventListener('scroll', (e) => e.target instanceof HTMLInputElement && syncScroll(e.target), true);
stage.addEventListener('change', (e) => {
  const sel = e.target as HTMLSelectElement;
  if (!sel.matches('[data-kind-select]')) return;
  ensureActive(sel);
  const id = sel.closest<HTMLElement>('[data-sec]')!.dataset.sec!;
  change(() => (section(id)!.kind = sel.value as SectionKind), focus);
});
stage.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-sec-act]');
  if (b) ensureActive(b);
  if (b) sectionAction(b.dataset.secAct!, b.closest<HTMLElement>('[data-sec]')!.dataset.sec!);
});
stage.addEventListener('focusin', (e) => {
  // Clicking into another song's paper makes it the one being edited.
  ensureActive(e.target);
  focus = readFocus(e.target as Element) ?? focus;
  updateCounts();
});
// Trailing spaces in a chord lane only matter while you're placing a chord.
stage.addEventListener('focusout', (e) => {
  const el = e.target as HTMLInputElement;
  const f = readFocus(el);
  if (!f || f.field !== 'chords' || el.value === el.value.trimEnd()) return;
  el.value = el.value.trimEnd();
  lineAt(f.sec, f.line)!.chords = el.value;
  typed();
});
document.addEventListener('selectionchange', () => {
  const f = readFocus(document.activeElement);
  if (f) focus = f;
});

/* Drag sections (by the grip, or in the side panel) to reorder them. */
let dragId: string | null = null;
function dropIndex(y: number): number {
  const secs = Array.from(sheet.querySelectorAll<HTMLElement>('.sg-sec')).filter((s) => s.dataset.sec !== dragId);
  const k = secs.findIndex((s) => {
    const r = s.getBoundingClientRect();
    return y < r.top + r.height / 2;
  });
  return k < 0 ? secs.length : k;
}
function clearDropMarks() {
  for (const el of document.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
}
stage.addEventListener('dragstart', (e) => {
  const grip = (e.target as HTMLElement).closest('[data-drag]');
  if (!grip) return;
  ensureActive(grip);
  dragId = grip.closest<HTMLElement>('[data-sec]')!.dataset.sec!;
  e.dataTransfer?.setData('text/plain', dragId);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  grip.closest('.sg-sec')!.classList.add('is-dragging');
});
stage.addEventListener('dragover', (e) => {
  if (!dragId) return;
  e.preventDefault();
  clearDropMarks();
  const k = dropIndex(e.clientY);
  const secs = Array.from(sheet.querySelectorAll<HTMLElement>('.sg-sec')).filter((s) => s.dataset.sec !== dragId);
  if (secs[k]) secs[k].classList.add('drop-before');
  else secs[secs.length - 1]?.classList.add('drop-after');
});
stage.addEventListener('drop', (e) => {
  if (!dragId) return;
  e.preventDefault();
  const id = dragId;
  const k = dropIndex(e.clientY);
  change(() => (doc.sections = moveSection(doc.sections, id, k)), focus);
});
document.addEventListener('dragend', () => {
  dragId = null;
  clearDropMarks();
  sheet.querySelector('.is-dragging')?.classList.remove('is-dragging');
});

const structure = $('#sg-structure');
structure.addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('[data-goto]');
  if (!li) return;
  const s = section(li.dataset.goto!)!;
  const target = sheet.querySelector(`[data-sec="${s.id}"]`);
  target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  if (sourceOf(doc, s) === s) focusField(firstLine(s.id));
});
structure.addEventListener('dragstart', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('[data-goto]');
  if (!li) return;
  dragId = li.dataset.goto!;
  e.dataTransfer?.setData('text/plain', dragId);
});
structure.addEventListener('dragover', (e) => {
  if (!dragId) return;
  e.preventDefault();
  clearDropMarks();
  const items = Array.from(structure.querySelectorAll<HTMLElement>('li')).filter((li) => li.dataset.goto !== dragId);
  const k = items.findIndex((li) => e.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2);
  if (items[k]) items[k].classList.add('drop-before');
  else items[items.length - 1]?.classList.add('drop-after');
});
structure.addEventListener('drop', (e) => {
  if (!dragId) return;
  e.preventDefault();
  const id = dragId;
  const items = Array.from(structure.querySelectorAll<HTMLElement>('li')).filter((li) => li.dataset.goto !== id);
  let k = items.findIndex((li) => e.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2);
  if (k < 0) k = items.length;
  change(() => (doc.sections = moveSection(doc.sections, id, k)), focus);
});

/* -------------------------------------------------------------------- */
/* Title, details, toolbar                                               */
/* -------------------------------------------------------------------- */

titleInput.addEventListener('input', () => {
  if (album) {
    // In an album the header is the album's name (the songs have theirs on their papers).
    album.title = titleInput.value;
    renderChrome();
    scheduleSave();
    return;
  }
  doc.title = titleInput.value;
  const paperTitle = paperEl.querySelector<HTMLInputElement>('[data-song-title]');
  if (paperTitle) paperTitle.value = doc.title;
  renderChrome();
  typed();
});
const toFirstLine = () => {
  const first = allPositions()[0];
  if (first) focusField({ ...first, field: 'lyric', caret: 0 });
};
titleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (album) paperEl.querySelector<HTMLInputElement>('[data-song-title]')?.focus();
    else toFirstLine();
  }
});
// Enter / ↓ in a song's title goes to its first line.
stage.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement;
  if (!el.matches?.('[data-song-title]') || (e.key !== 'Enter' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  ensureActive(el);
  toFirstLine();
});

for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-meta]')) {
  el.addEventListener(el instanceof HTMLSelectElement ? 'change' : 'input', () => {
    const k = el.dataset.meta as 'writer' | 'key' | 'bpm' | 'time' | 'capo' | 'lang';
    if (k === 'lang') {
      doc.lang = el.value === 'en' ? 'en' : 'id';
      commit();
    } else {
      doc[k] = el.value;
      typed();
    }
    updateCounts();
  });
}

function setChords(on: boolean) {
  showChords = on;
  writeSettings({ songChords: on });
  stage.classList.toggle('no-chords', !on);
  $('[data-act="chords"]').setAttribute('aria-pressed', String(on));
  if (!on && focus?.field === 'chords') focusField({ ...focus, field: 'lyric' });
}

function transpose(n: number) {
  change(() => (doc = transposeSong(doc, n)), focus);
  toast(doc.key.trim() ? t('song.transposedTo', { key: doc.key.trim() }) : t(n > 0 ? 'song.transposedUp' : 'song.transposedDown'));
}

document.querySelector('.sg-toolbar')!.addEventListener('mousedown', (e) => {
  // Keep the caret in the lyrics while using the toolbar.
  if ((e.target as HTMLElement).closest('button')) e.preventDefault();
});
document.querySelector('.sg-toolbar')!.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('button');
  if (!b) return;
  if (b.dataset.add) return addSection(b.dataset.add as SectionKind);
  const act = b.dataset.act;
  if (act === 'repeat') repeatChorus();
  else if (act === 'note') addNote();
  else if (act === 'chords') setChords(!showChords);
  else if (act === 'up') transpose(1);
  else if (act === 'down') transpose(-1);
  else if (act === 'undo') undo();
  else if (act === 'redo') redo();
  else if (act === 'export') openExport();
  else if (act === 'print') printSong();
  else if (act === 'help') $<HTMLDialogElement>('#dlg-song-help').showModal();
});

const KIND_BY_KEY = new Map(SECTION_KINDS.map((k) => [k.key, k.kind]));

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape' && openMenu) return closeMenus();
  if (e.altKey && !mod && e.code.startsWith('Digit')) {
    const kind = KIND_BY_KEY.get(e.code.slice(5));
    if (kind) {
      e.preventDefault();
      addSection(kind);
    }
    return;
  }
  if (e.altKey && !mod && e.code === 'KeyN') {
    e.preventDefault();
    addNote();
    return;
  }
  if (!mod || e.altKey) return;
  const k = e.key.toLowerCase();
  // Typing in a sticky note keeps the browser's own undo.
  if ((k === 'z' || k === 'y') && (e.target as HTMLElement).closest?.('.sn')) return;
  if (k === 'o') {
    e.preventDefault();
    fileInput.click();
  } else if (e.key === '\\') {
    e.preventDefault();
    actions['toggle-sidebar']();
  } else if (k === '=' || k === '+') {
    e.preventDefault();
    setZoom(zoom + 0.1);
  } else if (k === '-') {
    e.preventDefault();
    setZoom(zoom - 0.1);
  } else if (k === '/') {
    e.preventDefault();
    actions.shortcuts();
  } else if (k === 'z' || k === 'y') {
    // Our own history, also inside the text fields (theirs doesn't know about lines and sections).
    e.preventDefault();
    if (k === 'y' || e.shiftKey) redo();
    else undo();
  } else if (k === 's') {
    e.preventDefault();
    flushTyping();
    void saveNow();
    if (e.shiftKey) void downloadTerra();
    else toast(t('toast.saved'));
  } else if (k === 'e' && e.shiftKey) {
    e.preventDefault();
    openExport();
  } else if (k === 'p') {
    e.preventDefault();
    printSong();
  }
});

/* -------------------------------------------------------------------- */
/* Export & print                                                        */
/* -------------------------------------------------------------------- */

const fileBase = (title = album ? album.title : doc.title, untitled = album ? t('mus.albumUntitled') : t('song.untitled')) =>
  (title.trim() || untitled)
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase();

const textOpts = (chords: boolean) => ({ chords, byLabel: t('song.by'), key: t('song.key'), capo: 'Capo', untitled: t('song.untitled') });
const albumLabel = () => t(album?.type === 'ep' ? 'mus.kind.ep' : 'mus.kind.album');
const albumOpts = (chords: boolean) => ({ ...textOpts(chords), albumUntitled: t('mus.albumUntitled'), typeLabel: albumLabel(), tracklistLabel: t('mus.tracklist') });

/** The whole project as a .terra file: the single, or the album with every track. */
async function downloadTerra() {
  flushTyping();
  writeBack();
  // The cover art goes inside the file, so it opens the same anywhere.
  const images = projectId ? await imagesAsDataUrls(projectId, [coverId()]) : {};
  const data = album ? serializeAlbum(album, images) : serializeSong(doc, images);
  if (!(await saveFile(`${fileBase()}.terra`, data, 'application/json'))) return;
  if (projectId) await markBackedUp(projectId);
  toast(t('bk.saved'));
}

const exportDialog = $<HTMLDialogElement>('#dlg-song-export');
const exportForm = $<HTMLFormElement>('#form-song-export');
function openExport() {
  flushTyping();
  (exportForm.elements.namedItem('chords') as HTMLInputElement).checked = showChords;
  exportDialog.showModal();
}
exportDialog.querySelector('[data-close]')!.addEventListener('click', () => exportDialog.close());
exportForm.addEventListener('submit', async () => {
  writeBack();
  const fmt = (exportForm.elements.namedItem('fmt') as RadioNodeList).value;
  const chords = (exportForm.elements.namedItem('chords') as HTMLInputElement).checked;
  // In an album: the whole album, or just the song that is open.
  const whole = !!album && (exportForm.elements.namedItem('scope') as RadioNodeList).value === 'album';
  if (fmt === 'terra') return void downloadTerra();
  const name = whole ? fileBase() : fileBase(doc.title, t('song.untitled'));
  if (fmt === 'txt') {
    const text = whole ? albumToText(album!, { ...albumOpts(chords) }) : songToText(doc, textOpts(chords));
    if (await saveFile(`${name}.txt`, text, 'text/plain')) toast(t('song.exported'));
    return;
  }
  const { buildSongPdf, buildAlbumPdf } = await import('./song-pdf');
  const blob = whole ? buildAlbumPdf(album!, { paper, ...albumOpts(chords) }) : buildSongPdf(doc, { paper, ...textOpts(chords) });
  if (await saveFile(`${name}.pdf`, blob, 'application/pdf')) toast(t('song.exported'));
});

function songPrintHtml(s: SongDoc, title: string): string {
  const labels = sectionLabels(s);
  const meta = showChords ? metaLine(s, textOpts(true)) : '';
  return `<div class="sp-print">
    <h1>${esc(title)}</h1>
    ${s.writer.trim() ? `<p class="sp-by">${esc(t('song.by'))} ${esc(s.writer.trim())}</p>` : ''}
    ${meta ? `<p class="sp-meta">${esc(meta)}</p>` : ''}
    ${s.sections
      .map(
        (sec) => `<section><h2>${esc(labels.get(sec.id)!)}</h2>${linesOf(s, sec)
          .map((l) => `${showChords && l.chords.trim() ? `<pre class="sp-chords">${esc(l.chords.trimEnd())}</pre>` : ''}<pre>${esc(l.lyric) || ' '}</pre>`)
          .join('')}</section>`,
      )
      .join('')}
  </div>`;
}

/** Print the song (in an album: every track, each from a new page). */
function printSong() {
  flushTyping();
  writeBack();
  $('#print-root').innerHTML = album
    ? album.tracks.map((s, i) => songPrintHtml(s, `${i + 1}. ${s.title.trim() || t('song.untitled')}`)).join('')
    : songPrintHtml(doc, doc.title.trim() || t('song.untitled'));
  $('#page-style').textContent = `@page { size: ${paper === 'a4' ? 'A4' : 'letter'}; margin: 0.75in; }`;
  window.print();
}

/* -------------------------------------------------------------------- */
/* Sticky notes                                                          */
/* -------------------------------------------------------------------- */

const NOTE_W = 190;
/** Narrow screens have no margins: notes are listed above the sheet instead of floating. */
const stackedMq = window.matchMedia('(max-width: 1100px)');

function noteHtml(n: StickyNote): string {
  const dots = NOTE_COLORS.map(
    (c) => `<button type="button" class="sn-dot" data-color="${c}" aria-label="${esc(t(`mus.color.${c}` as Key))}" title="${esc(t(`mus.color.${c}` as Key))}"${c === n.color ? ' aria-pressed="true"' : ''}></button>`,
  ).join('');
  return `<div class="sn" data-note="${n.id}" data-color="${n.color}" style="left:${n.x}px;top:${n.y}px">
    <span class="sn-tape" aria-hidden="true"></span>
    <div class="sn-head" title="${esc(t('mus.noteDrag'))}">
      <span class="sn-dots">${dots}</span>
      <button type="button" class="sn-del" data-del aria-label="${esc(t('mus.noteDelete'))}" title="${esc(t('mus.noteDelete'))}">×</button>
    </div>
    <textarea class="sn-text" rows="4" placeholder="${esc(t('mus.notePh'))}" spellcheck="false" aria-label="${esc(t('mus.note'))}">${esc(n.text)}</textarea>
  </div>`;
}

/** Keep a note on the desk: not past its left edge or under the scrollbar. */
function clampNote(x: number, y: number): [number, number] {
  const p = paperEl.getBoundingClientRect();
  const d = desk.getBoundingClientRect();
  const minX = d.left - p.left + 8;
  const maxX = d.right - p.left - NOTE_W - 18;
  return [Math.round(Math.max(minX, Math.min(maxX, x))), Math.round(Math.max(0, y))];
}

function renderNotes() {
  const notes = doc.notes ?? [];
  notesEl.hidden = !showNotes || !notes.length;
  notesEl.classList.toggle('is-stacked', stackedMq.matches);
  notesEl.innerHTML = notes.map(noteHtml).join('');
  if (!stackedMq.matches) {
    for (const el of notesEl.querySelectorAll<HTMLElement>('.sn')) {
      const n = notes.find((x) => x.id === el.dataset.note)!;
      const [x, y] = clampNote(n.x, n.y);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
  }
}
/** Redraw the notes on every paper (their margins move when the window changes size). */
function renderAllNotes() {
  for (const i of paperIndices()) {
    if (album && i !== trackIdx) withTrack(i, renderNotes);
  }
  renderNotes();
}
stackedMq.addEventListener('change', renderAllNotes);
window.addEventListener('resize', () => !stackedMq.matches && renderAllNotes());

/** A new note: at (x, y) on the sheet, or in the right margin next to where you're writing. */
function addNote(at?: { x: number; y: number }, color?: NoteColor) {
  if (!showNotes) setNotes(true);
  const p = paperEl.getBoundingClientRect();
  const line = focus ? fieldEl(focus)?.getBoundingClientRect() : null;
  const pos = at ?? { x: p.width + 16, y: line ? line.top - p.top - 10 : (doc.notes?.length ?? 0) * 28 + 20 };
  const [x, y] = clampNote(pos.x, pos.y);
  const n: StickyNote = { id: newSectionId(), x, y, text: '', color: color ?? NOTE_COLORS[(doc.notes?.length ?? 0) % NOTE_COLORS.length] };
  doc.notes = [...(doc.notes ?? []), n];
  renderNotes();
  const card = notesEl.querySelector<HTMLElement>(`[data-note="${n.id}"]`);
  // A little "stick" when it lands.
  card?.classList.add('is-new');
  card?.addEventListener('animationend', () => card.classList.remove('is-new'), { once: true });
  card?.querySelector('textarea')?.focus({ preventScroll: true });
  commit();
}

/* The pad tray: drag a pad onto the desk to peel off a note of that colour; a plain click sticks one beside your line. */
const tray = $('#sg-note-tray');
tray.addEventListener('pointerdown', (e) => {
  const pad = (e.target as HTMLElement).closest<HTMLElement>('[data-pad]');
  if (!pad || e.button !== 0) return;
  e.preventDefault();
  const color = pad.dataset.pad as NoteColor;
  const sx = e.clientX;
  const sy = e.clientY;
  let ghost: HTMLElement | null = null;
  pad.setPointerCapture(e.pointerId);
  const place = (ev: PointerEvent) => {
    ghost!.style.transform = `translate(${ev.clientX - NOTE_W / 2}px, ${ev.clientY - 18}px) rotate(-2deg)`;
    const over = overDesk(ev.clientX, ev.clientY);
    ghost!.classList.toggle('is-out', !over);
  };
  const move = (ev: PointerEvent) => {
    if (!ghost && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.className = 'sn-ghost';
      ghost.dataset.color = color;
      ghost.innerHTML = '<span class="sn-tape"></span>';
      document.body.appendChild(ghost);
      document.body.classList.add('is-peeling');
    }
    place(ev);
  };
  const up = (ev: PointerEvent) => {
    pad.removeEventListener('pointermove', move);
    document.body.classList.remove('is-peeling');
    if (!ghost) return addNote(undefined, color);
    ghost.remove();
    if (!overDesk(ev.clientX, ev.clientY)) return;
    ensureActive(paperAt(ev.clientY));
    const p = paperEl.getBoundingClientRect();
    addNote(stackedMq.matches ? undefined : { x: ev.clientX - p.left - NOTE_W / 2, y: ev.clientY - p.top - 18 }, color);
  };
  pad.addEventListener('pointermove', move);
  pad.addEventListener('pointerup', up, { once: true });
  pad.addEventListener('pointercancel', () => {
    ghost?.remove();
    document.body.classList.remove('is-peeling');
    pad.removeEventListener('pointermove', move);
  }, { once: true });
});
/** Is the pointer over the desk (and not back over the tray)? */
function overDesk(x: number, y: number): boolean {
  const d = desk.getBoundingClientRect();
  const tr = tray.getBoundingClientRect();
  const inTray = x >= tr.left && x <= tr.right && y >= tr.top && y <= tr.bottom;
  return !inTray && x >= d.left && x <= d.right && y >= d.top && y <= d.bottom;
}

const noteOf = (el: Element) => doc.notes?.find((n) => n.id === (el.closest<HTMLElement>('[data-note]')?.dataset.note ?? ''));

stage.addEventListener('input', (e) => {
  const ta = e.target as HTMLTextAreaElement;
  if (!ta.closest?.('[data-notes]')) return;
  ensureActive(ta);
  const n = noteOf(ta);
  if (!n) return;
  n.text = ta.value;
  typed();
});
stage.addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
  if (!el.closest('[data-notes]')) return;
  ensureActive(el);
  const n = noteOf(el);
  if (!n) return;
  if (el.closest('[data-del]')) {
    if (n.text.trim() && !confirm(t('mus.noteConfirmDelete'))) return;
    doc.notes = doc.notes!.filter((x) => x !== n);
    renderNotes();
    commit();
  } else if (el.dataset.color) {
    n.color = el.dataset.color as NoteColor;
    renderNotes();
    commit();
  }
});

// Drag a note by its top strip.
stage.addEventListener('pointerdown', (e) => {
  const head = (e.target as HTMLElement).closest('.sn-head');
  if (!head || (e.target as HTMLElement).closest('button') || stackedMq.matches) return;
  ensureActive(head);
  const card = head.closest<HTMLElement>('.sn')!;
  const n = noteOf(card)!;
  e.preventDefault();
  head.setPointerCapture(e.pointerId);
  card.classList.add('is-dragging');
  const startX = e.clientX;
  const startY = e.clientY;
  const from = { x: card.offsetLeft, y: card.offsetTop };
  const move = (ev: PointerEvent) => {
    const [x, y] = clampNote(from.x + ev.clientX - startX, from.y + ev.clientY - startY);
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  };
  const up = () => {
    head.removeEventListener('pointermove', move as EventListener);
    card.classList.remove('is-dragging');
    if (n.x !== card.offsetLeft || n.y !== card.offsetTop) {
      n.x = card.offsetLeft;
      n.y = card.offsetTop;
      commit();
    }
  };
  head.addEventListener('pointermove', move as EventListener);
  head.addEventListener('pointerup', up, { once: true });
  head.addEventListener('pointercancel', up, { once: true });
});

// Double-click the desk beside the sheet to stick a note there.
desk.addEventListener('dblclick', (e) => {
  const el = e.target as HTMLElement;
  if (el !== desk && el !== stage && !el.matches('.sg-paper')) return;
  // The note belongs to the song whose paper is nearest.
  ensureActive(el.matches('.sg-paper') ? el : paperAt(e.clientY));
  const p = paperEl.getBoundingClientRect();
  addNote({ x: e.clientX - p.left - 20, y: e.clientY - p.top - 14 });
});

function setNotes(on: boolean) {
  showNotes = on;
  writeSettings({ songNotes: on });
  renderNotes();
}

/* -------------------------------------------------------------------- */
/* Albums / EPs                                                          */
/* -------------------------------------------------------------------- */

/* Scroll mode: the song whose paper is at the top of the view is the current one
   (its details show in the side panel), unless you are typing in another. */
let spyFrame = 0;
desk.addEventListener('scroll', () => {
  if (!scrollMode()) return;
  cancelAnimationFrame(spyFrame);
  spyFrame = requestAnimationFrame(() => {
    if (stage.contains(document.activeElement)) return;
    const d = desk.getBoundingClientRect();
    const line = d.top + d.height * 0.3;
    for (const p of stage.querySelectorAll<HTMLElement>('[data-paper]')) {
      const r = p.getBoundingClientRect();
      if (r.top <= line && r.bottom > line) return activateTrack(Number(p.dataset.paper));
    }
  });
});

const tracksEl = $('#sg-tracks');

function renderTracks() {
  if (!album) return;
  tracksEl.innerHTML = album.tracks
    .map((s, i) => {
      const n = songStats(s).lines;
      return `<li draggable="true" data-track="${i}" class="${i === trackIdx ? 'is-current' : ''}">
        <span class="sg-tr-n">${i + 1}</span>
        <span class="sg-tr-title${s.title.trim() ? '' : ' is-empty'}">${esc(s.title.trim() || t('song.untitled'))}</span>
        <span class="sg-tr-lines">${n}</span>
        ${album!.tracks.length > 1 ? `<button type="button" class="sg-tr-del" data-del-track="${i}" title="${esc(t('mus.mDelTrack'))}" aria-label="${esc(t('mus.mDelTrack'))}">×</button>` : ''}
      </li>`;
    })
    .join('');
}

function renderAlbum() {
  const on = !!album;
  $('#sg-album').hidden = !on;
  for (const el of document.querySelectorAll<HTMLElement>('[data-only]')) el.hidden = el.dataset.only !== (on ? 'album' : 'single');
  if (!album) {
    $('#sg-badge-text').textContent = t('song.mode');
    return;
  }
  $('#sg-badge-text').textContent = album.title.trim() ? `${albumLabel()} · ${album.title.trim()}` : albumLabel();
  $('#sg-album-kind').textContent = albumLabel();
  $('[data-album-act="toggle-scroll"]').setAttribute('aria-checked', String(songScroll));
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-album]')) {
    const k = el.dataset.album as 'title' | 'artist' | 'type' | 'year';
    if (document.activeElement !== el) el.value = album[k];
  }
  renderTracks();
}

/**
 * Go to another song of the album (each song has its own undo history).
 * Scroll mode: glide to its paper. Otherwise: show it alone. `rebuild` redraws
 * every paper first (after songs were added, removed or reordered).
 */
function openTrack(i: number, rebuild = false) {
  if (!album || !album.tracks[i]) return;
  if (i === trackIdx && !rebuild) return;
  flushTyping();
  writeBack();
  if (scrollMode() && !rebuild) {
    activateTrack(i);
    void saveNow();
    paperEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
    paperEl.querySelector<HTMLInputElement>('[data-song-title]')?.focus({ preventScroll: true });
    return;
  }
  trackIdx = i;
  doc = album.tracks[i];
  history = [];
  hIndex = -1;
  focus = null;
  buildPapers();
  commit();
  void saveNow();
  const params = new URLSearchParams(location.search);
  params.set('t', doc.id ?? '');
  window.history.replaceState(null, '', `${location.pathname}?${params}`);
  if (scrollMode()) paperEl.scrollIntoView({ block: 'start' });
  else desk.scrollTo({ top: 0 });
  paperEl.querySelector<HTMLInputElement>('[data-song-title]')?.focus({ preventScroll: true });
}

function newTrack() {
  if (!album) return;
  writeBack();
  album.tracks.push({ ...emptySong(doc.lang), id: newSectionId() });
  // Its paper starts with the title field focused.
  openTrack(album.tracks.length - 1, true);
}

/** Albums: all songs on one scroll, or one song at a time. */
function setScroll(on: boolean) {
  songScroll = on;
  writeSettings({ songScroll: on });
  if (!album) return;
  flushTyping();
  buildPapers();
  if (on) paperEl.scrollIntoView({ block: 'start' });
  else desk.scrollTo({ top: 0 });
}

function deleteTrack(i: number) {
  if (!album || album.tracks.length < 2) return;
  const s = album.tracks[i];
  if (!confirm(t('mus.confirmDelTrack', { name: s.title.trim() || t('song.untitled') }))) return;
  flushTyping();
  writeBack();
  album.tracks.splice(i, 1);
  // Stay on the same song; if it was the one removed, open the one now in its place.
  const next = Math.min(i < trackIdx ? trackIdx - 1 : trackIdx, album.tracks.length - 1);
  trackIdx = -1;
  openTrack(next, true);
}

/** Take the open track out as its own single (the album keeps it unless you remove it). */
async function trackToSingle() {
  if (!album) return;
  flushTyping();
  writeBack();
  const id = await createSong(asSingle(doc));
  toast(t('mus.madeSingle', { name: doc.title.trim() || t('song.untitled') }));
  return id;
}

async function addSingles() {
  if (!album || !projectId) return;
  const pick = await pickSingles();
  if (pick === 'none') return toast(t('mus.noSingles'));
  if (!pick) return;
  flushTyping();
  await saveNow();
  await addSongsToAlbum(projectId, pick.ids, pick.move);
  const fresh = await loadAlbum(projectId);
  if (!fresh) return;
  const before = album.tracks.length;
  album = fresh.doc;
  trackIdx = -1;
  openTrack(Math.min(before, album.tracks.length - 1), true);
  toast(t(pick.ids.length === 1 ? 'mus.added1' : 'mus.added', { n: pick.ids.length }));
}

/** This single into an album / EP (from the File menu). */
async function toAlbum() {
  if (album || !projectId) return;
  flushTyping();
  await saveNow();
  const choice = await pickAlbumFor(doc.title.trim() || t('song.untitled'));
  if (!choice) return;
  const albumId = choice.albumId ?? (await createAlbum({ ...emptyAlbum(choice.newType, doc.lang, choice.newTitle), tracks: [] }));
  await addSongsToAlbum(albumId, [projectId], choice.move);
  if (choice.move) {
    // The song now lives in the album: open it there.
    dirty = false;
    location.href = songUrl(albumId);
  } else toast(t('mus.copiedTo', { name: doc.title.trim() || t('song.untitled'), album: choice.newTitle || t('mus.theAlbum') }));
}

tracksEl.addEventListener('click', (e) => {
  const el = e.target as HTMLElement;
  const del = el.closest<HTMLElement>('[data-del-track]');
  if (del) return deleteTrack(Number(del.dataset.delTrack));
  const li = el.closest<HTMLElement>('[data-track]');
  if (li) openTrack(Number(li.dataset.track));
});
let dragTrack = -1;
tracksEl.addEventListener('dragstart', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('[data-track]');
  if (!li) return;
  dragTrack = Number(li.dataset.track);
  e.dataTransfer?.setData('text/plain', String(dragTrack));
});
tracksEl.addEventListener('dragover', (e) => {
  if (dragTrack < 0) return;
  e.preventDefault();
  clearDropMarks();
  const items = Array.from(tracksEl.querySelectorAll<HTMLElement>('li')).filter((li) => Number(li.dataset.track) !== dragTrack);
  const k = items.findIndex((li) => e.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2);
  if (items[k]) items[k].classList.add('drop-before');
  else items[items.length - 1]?.classList.add('drop-after');
});
tracksEl.addEventListener('drop', (e) => {
  if (!album || dragTrack < 0) return;
  e.preventDefault();
  writeBack();
  const items = Array.from(tracksEl.querySelectorAll<HTMLElement>('li')).filter((li) => Number(li.dataset.track) !== dragTrack);
  let k = items.findIndex((li) => e.clientY < li.getBoundingClientRect().top + li.offsetHeight / 2);
  if (k < 0) k = items.length;
  const current = album.tracks[trackIdx];
  const [moved] = album.tracks.splice(dragTrack, 1);
  album.tracks.splice(k, 0, moved);
  trackIdx = album.tracks.indexOf(current);
  dragTrack = -1;
  clearDropMarks();
  // In scroll mode the papers follow the new order.
  if (scrollMode()) buildPapers();
  else renderTracks();
  scheduleSave();
});
tracksEl.addEventListener('dragend', () => (dragTrack = -1));

for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-album]')) {
  el.addEventListener(el instanceof HTMLSelectElement ? 'change' : 'input', () => {
    if (!album) return;
    const k = el.dataset.album as 'title' | 'artist' | 'type' | 'year';
    if (k === 'type') album.type = el.value === 'ep' ? 'ep' : 'album';
    else album[k] = el.value;
    renderChrome();
    scheduleSave();
  });
}
document.querySelector('.sg-album')!.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-album-act]')?.dataset.albumAct;
  if (act === 'new-track') newTrack();
  else if (act === 'toggle-scroll') setScroll(!songScroll);
  else if (act === 'add-singles') void addSingles();
});

/* -------------------------------------------------------------------- */
/* Cover art and mockups                                                 */
/* -------------------------------------------------------------------- */

/** The cover belongs to the single, or to the album (not to its songs). */
const coverId = () => (album ? album.cover : doc.cover);
let shownCover: string | undefined;
let coverImg: HTMLImageElement | null = null;
const coverBox = $('#sg-cover');
const coverImgEl = $<HTMLImageElement>('#sg-cover-img');
const coverInput = $<HTMLInputElement>('#cover-input');

/** Show the current cover in the side panel (loads it from the image store when it changed). */
function syncCover() {
  const id = coverId();
  if (id === shownCover) return;
  shownCover = id;
  if (coverImgEl.src) URL.revokeObjectURL(coverImgEl.src);
  coverImg = null;
  coverImgEl.hidden = true;
  coverImgEl.removeAttribute('src');
  coverBox.classList.remove('has-cover');
  $('[data-cover-act="remove"]').hidden = true;
  if (!id || !projectId) return;
  void getImage(projectId, id).then(async (blob) => {
    if (!blob || coverId() !== id) return;
    const url = URL.createObjectURL(blob);
    coverImgEl.src = url;
    coverImgEl.hidden = false;
    coverBox.classList.add('has-cover');
    $('[data-cover-act="remove"]').hidden = false;
    coverImg = await loadImage(url).catch(() => null);
  });
}

async function setCoverFile(file: File | undefined) {
  if (!file || !projectId) return;
  if (!file.type.startsWith('image/')) return toast(t('cov.notImage'));
  try {
    const blob = await prepareCover(file);
    const id = newSectionId();
    await putImage(projectId, id, blob);
    if (album) {
      album.cover = id;
      scheduleSave();
    } else {
      doc.cover = id;
      commit();
    }
    syncCover();
    toast(t('cov.added'));
  } catch (err) {
    console.error(err);
    toast(t('cov.failed'));
  }
}

function removeCover() {
  if (album) {
    delete album.cover;
    scheduleSave();
  } else {
    delete doc.cover;
    commit();
  }
  syncCover();
}

coverBox.addEventListener('click', () => coverInput.click());
coverBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    coverInput.click();
  }
});
coverInput.addEventListener('change', () => {
  const file = coverInput.files?.[0];
  coverInput.value = '';
  void setCoverFile(file);
});
// Drop an image file straight onto the cover box.
coverBox.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  coverBox.classList.add('is-over');
});
coverBox.addEventListener('dragleave', () => coverBox.classList.remove('is-over'));
coverBox.addEventListener('drop', (e) => {
  e.preventDefault();
  coverBox.classList.remove('is-over');
  void setCoverFile(e.dataTransfer?.files[0]);
});
document.querySelector('.sg-cover-actions')!.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-cover-act]')?.dataset.coverAct;
  if (act === 'change') coverInput.click();
  else if (act === 'remove') removeCover();
  else if (act === 'mockup') void openMockup();
});

const mockupDialog = $<HTMLDialogElement>('#dlg-mockup');
const mockupCanvas = $<HTMLCanvasElement>('#mockup-canvas');
const mockupForm = mockupDialog.querySelector('form')!;
const mockupChoice = () => {
  const data = new FormData(mockupForm);
  return { kind: (data.get('kind') as MockupKind) ?? 'vinyl', bg: (data.get('bg') as MockupBg) ?? 'blur' };
};
const mockupText = () => ({
  title: (album ? album.title : doc.title).trim() || t(album ? 'mus.albumUntitled' : 'song.untitled'),
  artist: (album ? album.artist : doc.writer).trim(),
  kind: album ? albumLabel() : t('mus.kind.single'),
});
function drawCurrentMockup() {
  const { kind, bg } = mockupChoice();
  drawMockup(mockupCanvas, coverImg, kind, bg, mockupText());
}
async function openMockup() {
  flushTyping();
  if (!coverId()) toast(t('cov.noCoverYet'));
  await document.fonts?.ready;
  drawCurrentMockup();
  mockupDialog.showModal();
}
mockupForm.addEventListener('change', drawCurrentMockup);
mockupDialog.querySelector('[data-close]')!.addEventListener('click', () => mockupDialog.close());
mockupDialog.querySelector('[data-mockup-save]')!.addEventListener('click', () => {
  const { kind } = mockupChoice();
  mockupCanvas.toBlob(async (blob) => {
    if (blob && (await saveFile(`${fileBase()}-mockup-${kind}.png`, blob, 'image/png'))) toast(t('cov.saved'));
  }, 'image/png');
});

/* -------------------------------------------------------------------- */
/* Menus (File, Edit, Insert, View, Tools, Help)                          */
/* -------------------------------------------------------------------- */

const fileInput = $<HTMLInputElement>('#file-input');
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  try {
    const url = await importFile(file);
    await saveNow();
    location.href = url;
  } catch (err) {
    console.error(err);
    toast(t('toast.badFile'));
  }
});

function setZoom(z: number) {
  zoom = Math.round(Math.min(1.6, Math.max(0.7, z)) * 10) / 10;
  writeSettings({ songZoom: zoom });
  stage.style.setProperty('--sg-zoom', String(zoom));
  toast(`${Math.round(zoom * 100)}%`);
}

function setTheme(theme: 'light' | 'dark' | 'system') {
  writeSettings({ theme });
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  themeTransition(() => {
    document.documentElement.classList.toggle('dark', dark);
    syncThemeSwitches();
  });
}

/** Paper colour, shared with the screenplay editor: match the theme, always light or always dark. */
type PaperColor = 'auto' | 'light' | 'dark';
const paperColor = (): PaperColor => {
  const v = readSettings().paperColor;
  return v === 'light' || v === 'dark' ? v : 'auto';
};
function setPaperColor(c: PaperColor) {
  writeSettings({ paperColor: c });
  if (c === 'auto') delete document.documentElement.dataset.paper;
  else document.documentElement.dataset.paper = c;
  renderPaperStatus();
}
function renderPaperStatus() {
  $('#st-paper').textContent = t(({ auto: 'st.paperAuto', light: 'st.paperLight', dark: 'st.paperDark' } as const)[paperColor()]);
}
$('#btn-paper').addEventListener('click', () => {
  const order: PaperColor[] = ['auto', 'light', 'dark'];
  setPaperColor(order[(order.indexOf(paperColor()) + 1) % order.length]);
});

function setUiLang(lang: Lang) {
  setLang(lang);
  writeSettings({ lang });
  translate();
  buildPapers();
}

function moveLine(dir: 1 | -1) {
  if (!focus) return;
  const s = section(focus.sec);
  const to = focus.line + dir;
  if (!s || to < 0 || to >= s.lines.length) return;
  const f = focus;
  change(() => ([s.lines[f.line], s.lines[to]] = [s.lines[to], s.lines[f.line]]), { ...f, line: to });
}

const actions: Record<string, () => void> = {
  projects: () => {
    void saveNow().then(() => (location.href = '/projects?tab=song'));
  },
  'new-single': () => {
    void saveNow()
      .then(() => createSong(emptySong(doc.lang)))
      .then((id) => (location.href = songUrl(id)));
  },
  'new-album': async () => {
    const kind = await chooseNewKind();
    if (!kind) return;
    await saveNow();
    location.href = songUrl(kind === 'single' ? await createSong(emptySong(doc.lang)) : await createAlbum(emptyAlbum(kind, doc.lang)));
  },
  import: () => fileInput.click(),
  'save-terra': () => void downloadTerra(),
  export: openExport,
  print: printSong,
  'cover-pick': () => coverInput.click(),
  'cover-mockup': () => void openMockup(),
  'to-album': () => void toAlbum(),
  'add-singles': () => void addSingles(),
  'track-to-single': () => void trackToSingle(),
  undo,
  redo,
  'line-up': () => moveLine(-1),
  'line-down': () => moveLine(1),
  'dup-section': () => focus && sectionAction('dup', focus.sec),
  'del-section': () => focus && sectionAction('del', focus.sec),
  'del-track': () => deleteTrack(trackIdx),
  'repeat-chorus': repeatChorus,
  'add-note': () => addNote(),
  'new-track': newTrack,
  'toggle-chords': () => setChords(!showChords),
  'toggle-notes': () => setNotes(!showNotes),
  'toggle-scroll': () => setScroll(!songScroll),
  'toggle-sidebar': () => {
    const side = $('.sg-side');
    side.hidden = !side.hidden;
    writeSettings({ songSidebar: !side.hidden });
    if (!side.hidden) renderNotes();
    else requestAnimationFrame(renderNotes);
  },
  'zoom-in': () => setZoom(zoom + 0.1),
  'zoom-out': () => setZoom(zoom - 0.1),
  'zoom-reset': () => setZoom(1),
  'theme-light': () => setTheme('light'),
  'theme-dark': () => setTheme('dark'),
  'theme-system': () => setTheme('system'),
  'paper-color-auto': () => setPaperColor('auto'),
  'paper-color-light': () => setPaperColor('light'),
  'paper-color-dark': () => setPaperColor('dark'),
  'lang-en': () => setUiLang('en'),
  'lang-id': () => setUiLang('id'),
  'transpose-up': () => transpose(1),
  'transpose-down': () => transpose(-1),
  'lyrics-id': () => {
    doc.lang = 'id';
    render();
    commit();
  },
  'lyrics-en': () => {
    doc.lang = 'en';
    render();
    commit();
  },
  shortcuts: () => $<HTMLDialogElement>('#dlg-song-help').showModal(),
};
for (const k of SECTION_KINDS) actions[`add-${k.kind}`] = () => addSection(k.kind);

/** Tick marks for the menus. */
function checks(key: string): boolean {
  const s = readSettings();
  if (key === 'chords') return showChords;
  if (key === 'notes') return showNotes;
  if (key === 'sidebar') return !$('.sg-side').hidden;
  if (key === 'scroll') return songScroll;
  if (key.startsWith('theme=')) return (s.theme ?? 'system') === key.slice(6);
  if (key.startsWith('paperColor=')) return paperColor() === key.slice(11);
  if (key.startsWith('lang=')) return getLang() === key.slice(5);
  if (key.startsWith('lyrics=')) return doc.lang === key.slice(7);
  return false;
}

let openMenu: HTMLElement | null = null;
function closeMenus() {
  openMenu?.classList.remove('open');
  openMenu?.querySelector('[data-menu-btn]')?.setAttribute('aria-expanded', 'false');
  openMenu = null;
}
function showMenu(menu: HTMLElement) {
  if (openMenu === menu) return;
  closeMenus();
  for (const item of menu.querySelectorAll<HTMLElement>('[data-check]')) item.setAttribute('aria-checked', String(checks(item.dataset.check!)));
  openMenu = menu;
  menu.classList.add('open');
  menu.querySelector('[data-menu-btn]')?.setAttribute('aria-expanded', 'true');
}
for (const menu of document.querySelectorAll<HTMLElement>('[data-menu]')) {
  const b = menu.querySelector<HTMLElement>('[data-menu-btn]')!;
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', () => (openMenu === menu ? closeMenus() : showMenu(menu)));
  b.addEventListener('mouseenter', () => openMenu && showMenu(menu));
}
for (const item of document.querySelectorAll<HTMLElement>('[data-action]')) {
  item.addEventListener('mousedown', (e) => e.preventDefault());
  item.addEventListener('click', () => {
    closeMenus();
    actions[item.dataset.action!]?.();
  });
}
document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target as Node)) closeMenus();
});

/* -------------------------------------------------------------------- */
/* Misc                                                                  */
/* -------------------------------------------------------------------- */

let toastTimer: number | undefined;
function toast(msg: string) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 3200);
}

for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('close', () => focus && focusField(focus));
}

function translate() {
  applyI18n();
  renderPaperStatus();
  document.title = `${doc?.title.trim() || t('song.pageTitle')} — Terra Script`;
  document.documentElement.classList.remove('i18n-pending');
}

/* -------------------------------------------------------------------- */
/* Boot                                                                  */
/* -------------------------------------------------------------------- */

(async () => {
  translate();
  initDesktopPromo();
  if (!projectId) {
    location.replace('/projects?tab=song');
    return;
  }
  try {
    const single = await loadSong(projectId);
    const albumP = single ? null : await loadAlbum(projectId);
    if (!single && !albumP) {
      location.replace('/projects?missing=1');
      return;
    }
    const unsaved = takeUnsaved((single ?? albumP)!.meta.updatedAt);
    if (single) doc = unsaved?.song ?? single.doc;
    else {
      album = unsaved?.album ?? albumP!.doc;
      // ?t= opens a given track (kept in the address while you switch).
      const want = new URLSearchParams(location.search).get('t');
      trackIdx = Math.max(0, album.tracks.findIndex((x) => x.id === want));
      doc = album.tracks[trackIdx];
    }
  } catch (err) {
    console.error(err);
    toast(t('proj.storageError'));
    hideLoader();
    return;
  }
  $('.sg-side').hidden = settings.songSidebar === false;
  buildPapers();
  setChords(showChords);
  translate();
  commit();
  dirty = false;
  saveStatus.textContent = '';
  hideLoader();
  // A new album starts at its name; a new song at its title (top of the paper); otherwise at the first line.
  const fresh = !doc.title.trim() && songStats(doc).words === 0;
  if (album && fresh && !album.title.trim() && album.tracks.length === 1) titleInput.focus();
  else if (fresh) paperEl.querySelector<HTMLInputElement>('[data-song-title]')?.focus();
  else {
    if (scrollMode() && trackIdx > 0) paperEl.scrollIntoView({ block: 'start' });
    const first = allPositions()[0];
    if (first) focusField({ ...first, field: 'lyric', caret: 0 });
  }
})();
