import { ScreenplayEditor, setSuggestionLang } from './editor';
import { normalizeTitlePage, toFountain, toPlainText } from './fountain';
import { buildPdf, pageStarts, type PageStart } from './pdf';
import { applyPageView } from './page-view';
import { hideLoader, initThemeSwitches, syncThemeSwitches, themeTransition } from './ui-effects';
import { buildReport, characterStats, reportToText } from './report';
import { createCardsBoard } from './cards';
import { renameCharacter } from './rename';
import { createTakesPanel } from './takes';
import {
  clearUnsaved,
  createProject,
  editorUrl,
  importFile,
  loadProject,
  markBackedUp,
  migrateLegacy,
  requestPersistence,
  saveProject,
  serializeTerra,
  setBackupReminder,
  shouldRemindBackup,
  type ProjectMeta,
  takeUnsaved,
  writeUnsaved,
} from './projects';
import { buildPrintHtml } from './print';
import { PLACEHOLDER_TYPES, applyI18n, getLang, sampleScript, setLang, t, type Key, type Lang } from './i18n';
import {
  ELEMENTS,
  LABELS,
  NEXT_ON_ENTER,
  TAB_NEXT,
  characterName,
  emptyTitlePage,
  type Block,
  type ElType,
  type ScriptDoc,
  type TitlePage,
  type Take,
  sceneTakeStatus,
} from './types';

/* -------------------------------------------------------------------- */
/* State & persistence                                                   */
/* -------------------------------------------------------------------- */

const SETTINGS_KEY = 'tewrite:settings';

interface Settings {
  sceneNumbers: boolean;
  pageMarkers: boolean;
  sidebar: boolean;
  theme: 'light' | 'dark' | 'system';
  paper: 'letter' | 'a4';
  zoom: number;
  sidebarTab: 'scenes' | 'characters' | 'stats';
  showTitlePage: boolean;
  includeTitlePage: boolean;
  paperColor: 'auto' | 'light' | 'dark';
  lang: Lang;
  exportFormat: 'pdf' | 'fountain' | 'txt' | 'terra';
  exportScript: boolean;
  exportStats: boolean;
  exportChars: boolean;
  view: 'script' | 'cards';
  exportTakes: boolean;
}

const defaultSettings: Settings = {
  showTitlePage: true,
  includeTitlePage: true,
  exportFormat: 'pdf',
  exportScript: true,
  exportStats: false,
  view: 'script',
  exportTakes: false,
  exportChars: false,
  paperColor: 'auto',
  lang: 'en',
  sceneNumbers: true,
  pageMarkers: true,
  sidebar: true,
  theme: 'system',
  paper: 'letter',
  zoom: 1,
  sidebarTab: 'scenes',
};

const load = <T,>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};
const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

const settings: Settings = { ...defaultSettings, ...(load<Partial<Settings>>(SETTINGS_KEY) ?? {}) };
let titlePage: TitlePage = emptyTitlePage();

setLang(settings.lang);
setSuggestionLang(getLang());
const locale = () => (getLang() === 'id' ? 'id-ID' : 'en-US');

function openSample() {
  replaceDoc({
    titlePage: { ...emptyTitlePage(), title: t('sample.title'), credit: t('tp.credit'), author: t('sample.author') },
    blocks: sampleScript(getLang()),
  });
}

/* -------------------------------------------------------------------- */
/* DOM refs                                                              */
/* -------------------------------------------------------------------- */

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => Array.from(document.querySelectorAll<T>(sel));

const editorEl = $('#editor');
const paper = $('#paper');
const markersEl = $('#page-markers');
const titleInput = $<HTMLInputElement>('#doc-title');
const saveStatus = $('#save-status');

/* -------------------------------------------------------------------- */
/* Editor                                                                */
/* -------------------------------------------------------------------- */

const projectId = new URLSearchParams(location.search).get('p');

// Save bookkeeping: every edit bumps changeVersion; a finished save records savedVersion.
let changeVersion = 0;
let savedVersion = 0;
let loading = false;
let lastSavedAt: Date | null = null;
let saveFailed = false;
let saveChain: Promise<unknown> = Promise.resolve();

let changeTimer: number | undefined;
const editor = new ScreenplayEditor(editorEl, {
  onChange: () => {
    if (loading) return;
    changeVersion++;
    saveStatus.textContent = t('save.saving');
    window.clearTimeout(changeTimer);
    changeTimer = window.setTimeout(afterChange, 250);
  },
  onCaretMove: (type, index) => {
    updateToolbar(type);
    updateStatus(type);
    highlightScene(index);
    takesPanel.follow(sceneAt(index));
    updateTakeStatus(index);
  },
});

function currentDoc(): ScriptDoc {
  return {
    version: 2,
    titlePage: { ...titlePage },
    blocks: editor.getBlocks(),
    layout: { paper: settings.paper, sceneNumbers: settings.sceneNumbers },
  };
}

/** Paper size / scene numbers belong to the script: save them with it. */
function layoutChanged() {
  applySettings();
  changeVersion++;
  persist();
}

function renderSaveStatus() {
  if (saveFailed) saveStatus.textContent = t('save.failed');
  else if (changeVersion !== savedVersion) saveStatus.textContent = t('save.saving');
  else if (lastSavedAt)
    saveStatus.textContent = t('save.saved', {
      time: lastSavedAt.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }),
    });
  else saveStatus.textContent = '';
}

/** Save the open project to IndexedDB if anything changed. Saves run one after another. */
function persist(): Promise<unknown> {
  if (!projectId || changeVersion === savedVersion) return saveChain;
  const version = changeVersion;
  const doc = currentDoc();
  renderSaveStatus();
  saveChain = saveChain
    .then(() => saveProject(projectId, doc))
    .then(
      () => {
        savedVersion = Math.max(savedVersion, version);
        saveFailed = false;
        lastSavedAt = new Date();
        if (savedVersion === changeVersion) clearUnsaved(projectId);
        renderSaveStatus();
      },
      (err) => {
        console.error(err);
        saveFailed = true;
        writeUnsaved(projectId, doc); // keep a copy so nothing is lost
        renderSaveStatus();
      },
    );
  return saveChain;
}

/** Make sure everything is written before leaving the page. */
async function saveNow() {
  editor.flush();
  await persist();
}

function afterChange() {
  persist();
  renderSidebar();
  layoutPages();
  if (settings.view === 'cards' && !board.isEditing()) board.render();
  takesPanel.refresh();
  updateTakeStatus(editor.currentIndex());
}

function openDoc(doc: { titlePage?: Partial<TitlePage>; blocks: Block[]; layout?: ScriptDoc['layout'] }) {
  if (doc.layout) {
    settings.paper = doc.layout.paper;
    settings.sceneNumbers = doc.layout.sceneNumbers;
    applySettings();
  }
  loading = true;
  titlePage = normalizeTitlePage(doc.titlePage);
  syncTitleUI();
  editor.load(doc.blocks);
  loading = false;
  editor.focus(0, 0);
  updateDocTitle();
  renderSidebar();
  layoutPages();
  if (settings.view === 'cards') board.render();
}

/** Replace the open project's content (e.g. with the sample) and save it. */
function replaceDoc(doc: { titlePage?: Partial<TitlePage>; blocks: Block[] }) {
  openDoc(doc);
  changeVersion++;
  persist();
}

function updateDocTitle() {
  document.title = titlePage.title.trim() ? `${titlePage.title} — Terra Script` : t('ui.appTitle');
}

/* -------------------------------------------------------------------- */
/* Toolbar & status                                                      */
/* -------------------------------------------------------------------- */

function updateToolbar(type: ElType) {
  for (const b of $$('[data-el-type]')) {
    const active = b.dataset.elType === type;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  }
  const select = $<HTMLSelectElement>('#type-select');
  if (select) select.value = type;
}

function updateStatus(type: ElType) {
  $('#st-type').textContent = LABELS[type];
  $('#st-enter').textContent = LABELS[NEXT_ON_ENTER[type]];
  $('#st-tab').textContent = LABELS[TAB_NEXT[type]];
}

for (const btn of $$('[data-el-type]')) {
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    // The ripple starts where the button was pressed.
    const r = btn.getBoundingClientRect();
    btn.style.setProperty('--x', `${e.clientX - r.left}px`);
    btn.style.setProperty('--y', `${e.clientY - r.top}px`);
  });
  btn.addEventListener('click', () => editor.setType(btn.dataset.elType as ElType));
}
$('#type-select').addEventListener('change', (e) => {
  editor.setType((e.target as HTMLSelectElement).value as ElType);
  editor.focus();
});

function dual() {
  if (!editor.toggleDual()) toast(t('toast.dual'));
}
$('#btn-dual').addEventListener('mousedown', (e) => e.preventDefault());
$('#btn-dual').addEventListener('click', dual);
/* -------------------------------------------------------------------- */
/* Script ⇄ index cards                                                  */
/* -------------------------------------------------------------------- */

const boardEl = $('#board');
const board = createCardsBoard(boardEl, editor, {
  sceneNumbers: () => settings.sceneNumbers,
  onTakes: (blockIndex) => takesPanel.open(blockIndex),
  onOpenScene: (blockIndex) => {
    setView('script');
    editor.focus(blockIndex);
  },
});

/* -------------------------------------------------------------------- */
/* Take log                                                              */
/* -------------------------------------------------------------------- */

const takesPanel = createTakesPanel($('#takes-panel'), editor, {
  onToggle: (open) => {
    $('#btn-takes').setAttribute('aria-pressed', String(open));
    // The writing area got narrower/wider: refit the page.
    applyZoom();
    layoutPages();
  },
});

/** Index of the scene heading that owns block `index`, or null before the first scene. */
function sceneAt(index: number): number | null {
  const els = editorEl.children;
  for (let i = Math.min(index, els.length - 1); i >= 0; i--) {
    if ((els[i] as HTMLElement).dataset.type === 'scene') return i;
  }
  return null;
}

/** Status-bar summary for the scene at the cursor. */
function updateTakeStatus(index: number) {
  const scene = index >= 0 ? sceneAt(index) : null;
  const el = scene === null ? null : (editorEl.children[scene] as HTMLElement);
  let takes: Take[] = [];
  try {
    takes = el?.dataset.takes ? (JSON.parse(el.dataset.takes) as Take[]) : [];
  } catch {
    takes = [];
  }
  const status = sceneTakeStatus(takes);
  const dot = $('#btn-takes .take-dot');
  if (status) dot.dataset.status = status;
  else delete dot.dataset.status;
  $('#st-takes').textContent = takes.length
    ? `${t(takes.length === 1 ? 'take.count1' : 'take.count', { n: takes.length })}${status && status !== 'pending' ? ` · ${t(`take.${status}` as Key)}` : ''}`
    : t('take.title');
}

function toggleTakes() {
  if (takesPanel.isOpen()) return takesPanel.close();
  let scene: number | null = null;
  if (settings.view === 'cards') {
    const card = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.scard');
    scene = card ? Number(card.dataset.block) : null;
  } else scene = sceneAt(editor.currentIndex());
  takesPanel.toggle(scene);
}
$('#btn-takes').addEventListener('mousedown', (e) => e.preventDefault());
for (const id of ['#btn-hide-sidebar', '#btn-show-sidebar']) {
  $(id).addEventListener('mousedown', (e) => e.preventDefault());
  $(id).addEventListener('click', () => actions['toggle-sidebar']());
}
$('#btn-takes').addEventListener('click', toggleTakes);

function setView(view: Settings['view']) {
  settings.view = view;
  const cards = view === 'cards';
  boardEl.hidden = !cards;
  $('main.desk').hidden = cards;
  $('#el-toolbar').hidden = cards;
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=view]')) r.checked = r.value === view;
  editor.closeSuggestions();
  applySettings();
  if (cards) {
    editor.flush();
    board.render();
    // Start on the card of the scene the cursor was in.
    const at = editor.currentIndex();
    const blocks = editor.getBlocks();
    let scene = -1;
    for (let i = 0; i <= at && i < blocks.length; i++) if (blocks[i].type === 'scene') scene = i;
    if (scene >= 0) board.focusScene(scene);
  } else {
    layoutPages();
    editor.focus();
  }
}
for (const r of document.querySelectorAll<HTMLInputElement>('input[name=view]')) {
  r.addEventListener('change', () => r.checked && setView(r.value as Settings['view']));
}

$('#btn-title').addEventListener('mousedown', (e) => e.preventDefault());
$('#btn-title').addEventListener('click', openTitlePage);

/* -------------------------------------------------------------------- */
/* Sidebar                                                               */
/* -------------------------------------------------------------------- */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

let sceneIndices: number[] = [];

/** Small coloured dot for a scene's take result (side panel). */
function takeDot(takes: Take[] | undefined): string {
  const status = sceneTakeStatus(takes);
  return status ? `<i class="take-dot" data-status="${status}" title="${esc(t(takes!.length === 1 ? 'take.count1' : 'take.count', { n: takes!.length }))}"></i>` : '';
}

function renderSidebar() {
  const blocks = editor.getBlocks();
  // Mark scene headings in the script with their take result (green/yellow/red bar).
  const els = editorEl.children;
  blocks.forEach((b, i) => {
    const el = els[i] as HTMLElement | undefined;
    if (!el) return;
    const status = b.type === 'scene' ? sceneTakeStatus(b.takes) : null;
    if (status) el.dataset.takeStatus = status;
    else delete el.dataset.takeStatus;
  });

  // Scenes (with sequences / acts as group headers)
  sceneIndices = [];
  const items: string[] = [];
  let n = 0;
  blocks.forEach((b, i) => {
    if (b.type === 'scene') {
      n++;
      sceneIndices.push(i);
      // The card synopsis, else the first line of action, works as a summary.
      let synopsis = b.synopsis?.trim() ?? '';
      for (let j = i + 1; j < blocks.length && blocks[j].type !== 'scene'; j++) {
        if (synopsis) break;
        if (blocks[j].type === 'action' && blocks[j].text.trim()) {
          synopsis = blocks[j].text.trim();
          break;
        }
      }
      items.push(`<li><button class="nav-scene" data-block="${i}">
        <span class="nav-num">${n}${b.color ? `<i class="nav-dot" data-color="${esc(b.color)}"></i>` : ''}</span>${takeDot(b.takes)}
        <span class="min-w-0"><span class="nav-head">${esc(b.text.toUpperCase()) || `<em>${t('nav.untitledScene')}</em>`}</span>
        ${synopsis ? `<span class="nav-syn">${esc(synopsis)}</span>` : ''}</span></button></li>`);
    } else if (b.type === 'section' || b.type === 'act') {
      items.push(`<li><button class="nav-group" data-block="${i}">${esc(b.text) || t(b.type === 'act' ? 'nav.act' : 'nav.sequence')}</button></li>`);
    }
  });
  $('#scene-list').innerHTML = items.length
    ? items.join('')
    : `<li class="nav-empty">${t('nav.noScenes')}</li>`;
  $('#scene-count').textContent = String(n);

  // Characters
  const chars = characterStats(blocks);
  const max = chars[0]?.dialogues ?? 1;
  $('#char-list').innerHTML = chars.length
    ? chars
        .map(
          (c) => `<li class="char-row">
          <div class="flex items-center justify-between gap-2"><span class="font-semibold truncate">${esc(c.name)}</span><span class="flex items-center gap-1 shrink-0"><span class="text-muted">${t('char.lines', { n: c.dialogues })}</span><button type="button" class="char-rename" data-rename="${esc(c.name)}" title="${esc(t('rc.btn', { name: c.name }))}" aria-label="${esc(t('rc.btn', { name: c.name }))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button></span></div>
          <div class="bar"><span style="width:${(c.dialogues / max) * 100}%"></span></div>
          <div class="text-muted text-xs">${t('char.meta', { w: c.words, s: c.scenes.size })}</div></li>`,
        )
        .join('')
    : `<li class="nav-empty">${t('nav.noChars')}</li>`;

  // Stats
  const words = blocks.filter((b) => b.type !== 'note').reduce((s, b) => s + countWords(b.text), 0);
  const dialogueWords = blocks.filter((b) => b.type === 'dialogue').reduce((s, b) => s + countWords(b.text), 0);
  // Page count first: the runtime estimate depends on it.
  layoutPages();
  const pages = pageCount;
  const stats: [string, string, string?][] = [
    [t('stat.pages'), String(pages), 'stat-pages'],
    [t('stat.runtime'), t('stat.runtimeVal', { n: pages }), 'stat-runtime'],
    [t('stat.scenes'), String(n)],
    [t('stat.speaking'), String(chars.length)],
    [t('stat.words'), words.toLocaleString(locale())],
    [t('stat.dialogueRatio'), words ? `${Math.round((dialogueWords / words) * 100)}%` : '–'],
    [t('stat.intExt'), `${blocks.filter((b) => b.type === 'scene' && /^INT/i.test(b.text)).length} / ${blocks.filter((b) => b.type === 'scene' && /^EXT/i.test(b.text)).length}`],
    [t('stat.notes'), String(blocks.filter((b) => b.type === 'note').length)],
  ];
  $('#stats-list').innerHTML = stats
    .map(([k, v, id]) => `<div class="stat"><dt>${k}</dt><dd${id ? ` id="${id}"` : ''}>${v}</dd></div>`)
    .join('');
  $('#st-words').textContent = t('st.words', { n: words.toLocaleString(locale()) });

  highlightScene(editor.currentIndex());
}

function countWords(s: string) {
  const m = s.trim().match(/\S+/g);
  return m ? m.length : 0;
}

function highlightScene(blockIndex: number) {
  let current = -1;
  for (const i of sceneIndices) if (i <= blockIndex) current = i;
  for (const b of $$('#scene-list [data-block]')) b.classList.toggle('active', Number(b.dataset.block) === current);
}

for (const list of ['#scene-list']) {
  $(list).addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-block]');
    if (!btn) return;
    if (settings.view === 'cards') board.focusScene(Number(btn.dataset.block));
    else editor.focus(Number(btn.dataset.block));
  });
}

function setSidebarTab(tab: Settings['sidebarTab']) {
  settings.sidebarTab = tab;
  for (const b of $$('[data-tab]')) {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
  for (const p of $$('[data-panel]')) p.hidden = p.dataset.panel !== tab;
  save(SETTINGS_KEY, settings);
}
for (const b of $$('[data-tab]')) b.addEventListener('click', () => setSidebarTab(b.dataset.tab as Settings['sidebarTab']));

/* -------------------------------------------------------------------- */
/* Page layout (screen page-break markers)                               */
/* -------------------------------------------------------------------- */

let pageCount = 1;
/**
 * Page breaks on screen come from the same pagination as the PDF
 * (same lines per page, (MORE)/(CONT'D) splits, keep-with-next rules),
 * so the page count, runtime estimate and PDF always agree.
 */
function layoutPages() {
  let starts: PageStart[] = [];
  try {
    const result = pageStarts(editor.getBlocks(), { paper: settings.paper, sceneNumbers: settings.sceneNumbers });
    pageCount = result.pages;
    starts = result.starts;
  } catch (err) {
    console.error(err);
  }
  // Lay the script out as real sheets (margins, gaps, page numbers, MORE/CONT'D).
  const hadFocus = editorEl.contains(document.activeElement) || document.activeElement === editorEl;
  const caret = hadFocus ? editor.saveCaret() : null;
  applyPageView({
    paper,
    editor: editorEl,
    layer: markersEl,
    blocks: editor.getBlocks(),
    starts,
    size: settings.paper,
    enabled: settings.pageMarkers,
  });
  if (caret) editor.restoreCaret(caret);  $('#st-pages').textContent = t(pageCount === 1 ? 'st.page' : 'st.pages', { n: pageCount });
  const statPages = document.getElementById('stat-pages');
  const statRuntime = document.getElementById('stat-runtime');
  if (statPages) statPages.textContent = String(pageCount);
  if (statRuntime) statRuntime.textContent = t('stat.runtimeVal', { n: pageCount });
}
let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    applyZoom();
    layoutPages();
  }, 200);
});

/* -------------------------------------------------------------------- */
/* Settings / View                                                       */
/* -------------------------------------------------------------------- */

const media = window.matchMedia('(prefers-color-scheme: dark)');

function applySettings() {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && media.matches);
  document.documentElement.classList.toggle('dark', dark);
  syncThemeSwitches();
  // Paper colour is independent from the app theme.
  if (settings.paperColor === 'auto') delete document.documentElement.dataset.paper;
  else document.documentElement.dataset.paper = settings.paperColor;
  const paperKey = { auto: 'st.paperAuto', light: 'st.paperLight', dark: 'st.paperDark' }[settings.paperColor] as Key;
  $('#st-paper').textContent = t(paperKey);
  editorEl.classList.toggle('show-scene-numbers', settings.sceneNumbers);
  paper.classList.toggle('paper-a4', settings.paper === 'a4');
  applyZoom();
  $('#sidebar').hidden = !settings.sidebar;
  $('#btn-show-sidebar').hidden = settings.sidebar;
  $('#title-sheet').hidden = !settings.showTitlePage;
  $('#btn-title').setAttribute('aria-pressed', String(settings.showTitlePage));
  $('#st-zoom').textContent = `${Math.round(settings.zoom * 100)}%`;

  for (const item of $$('[data-check]')) {
    const key = item.dataset.check!;
    const [k, v] = key.split('=');
    const val = (settings as unknown as Record<string, unknown>)[k];
    const on = v === undefined ? Boolean(val) : String(val) === v;
    item.setAttribute('aria-checked', String(on));
  }
  save(SETTINGS_KEY, settings);
  layoutPages();
}
media.addEventListener('change', applySettings);

/** Change theme with the circular reveal growing from the theme switch. */
function setTheme(theme: Settings['theme']) {
  themeTransition(() => {
    settings.theme = theme;
    applySettings();
  }, document.querySelector('.theme-switch'));
}
initThemeSwitches((dark) => setTheme(dark ? 'dark' : 'light'));

/** Translate the whole UI into the chosen language. */
function applyLanguage(lang: Lang) {
  settings.lang = lang;
  setLang(lang);
  setSuggestionLang(lang);
  applyI18n();
  for (const type of PLACEHOLDER_TYPES) {
    editorEl.style.setProperty(`--ph-${type}`, JSON.stringify(t(`ph.${type}` as Key)));
  }
  updateDocTitle();
  applySettings();
  renderSidebar();
  layoutPages();
  renderSaveStatus();
  document.documentElement.classList.remove('i18n-pending');
}

function cyclePaperColor() {
  const order: Settings['paperColor'][] = ['auto', 'light', 'dark'];
  settings.paperColor = order[(order.indexOf(settings.paperColor) + 1) % order.length];
  applySettings();
}
$('#btn-paper').addEventListener('click', cyclePaperColor);

/** User zoom, reduced further if needed so the page fits narrow screens. */
function applyZoom() {
  const paperPx = (settings.paper === 'a4' ? 8.27 : 8.5) * 96;
  const desk = paper.parentElement;
  const cs = desk ? getComputedStyle(desk) : null;
  const pad = cs ? parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) : 16;
  const room = (desk?.clientWidth ?? window.innerWidth) - pad - 2;
  const fit = Math.min(1, room / paperPx);
  const z = String(Math.min(settings.zoom, fit));
  paper.style.setProperty('zoom', z);
  $('#title-sheet').style.setProperty('zoom', z);
  $('#title-sheet').classList.toggle('paper-a4', settings.paper === 'a4');
}

function setZoom(z: number) {
  settings.zoom = Math.round(Math.min(2, Math.max(0.5, z)) * 10) / 10;
  applySettings();
}

/* -------------------------------------------------------------------- */
/* Files                                                                 */
/* -------------------------------------------------------------------- */

const fileInput = $<HTMLInputElement>('#file-input');

function fileBase() {
  return (titlePage.title.trim() || t('file.default')).replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-').toLowerCase();
}

/* -------------------------------------------------------------------- */
/* Backups: one-time storage notice + reminder to download a .terra copy */
/* -------------------------------------------------------------------- */

const NOTICE_KEY = 'tewrite:storageNotice';
const SNOOZE_PREFIX = 'tewrite:bkSnooze:';
const SNOOZE_MS = 24 * 60 * 60 * 1000;

const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
};

function relTime(ts: number): string {
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const s = Math.round((ts - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return rtf.format(0, 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

/** Save, download the complete project as .terra and remember the backup. */
async function downloadTerra() {
  await saveNow();
  download(`${fileBase()}.terra`, serializeTerra(currentDoc()), 'application/json');
  if (projectId) {
    try {
      await markBackedUp(projectId);
    } catch {
      /* the file was still downloaded */
    }
  }
  requestPersistence();
  toast(t('bk.saved'));
}

function showStorageNotices(meta: ProjectMeta) {
  // First visit: explain where scripts live (and ask the browser to keep them).
  if (lsGet(NOTICE_KEY) !== '1') {
    const d = $<HTMLDialogElement>('#dlg-first');
    d.addEventListener(
      'close',
      () => {
        lsSet(NOTICE_KEY, '1');
        requestPersistence();
      },
      { once: true },
    );
    d.showModal();
    return;
  }
  if (!projectId || !shouldRemindBackup(meta)) return;
  if (Number(lsGet(SNOOZE_PREFIX + projectId) ?? 0) > Date.now()) return;

  const d = $<HTMLDialogElement>('#dlg-backup');
  $('#bk-body').textContent = meta.backedUpAt ? t('bk.stale', { time: relTime(meta.backedUpAt) }) : t('bk.never');
  d.returnValue = '';
  d.addEventListener(
    'close',
    () => {
      if (d.returnValue === 'download') downloadTerra();
      else if (d.returnValue !== 'off') lsSet(SNOOZE_PREFIX + projectId, String(Date.now() + SNOOZE_MS));
    },
    { once: true },
  );
  d.showModal();
}

$('#bk-off').addEventListener('click', async () => {
  if (projectId) await setBackupReminder(projectId, false);
  $<HTMLDialogElement>('#dlg-backup').close('off');
});

/* -------------------------------------------------------------------- */
/* Rename character                                                       */
/* -------------------------------------------------------------------- */

const rcDialog = $<HTMLDialogElement>('#dlg-rename-char');
const rcFrom = $<HTMLSelectElement>('#rc-from');
const rcTo = $<HTMLInputElement>('#rc-to');
const rcInText = $<HTMLInputElement>('#rc-intext');

/** The speaker of the dialogue the cursor is in, if any. */
function speakerAtCursor(): string {
  const blocks = editor.getBlocks();
  for (let i = editor.currentIndex(); i >= 0 && i < blocks.length; i--) {
    const b = blocks[i];
    if (b.type === 'character') return characterName(b.text);
    if (!['dialogue', 'parenthetical', 'lyrics'].includes(b.type)) break;
  }
  return '';
}

function updateRenamePreview() {
  const from = rcFrom.value;
  const to = rcTo.value.trim();
  const submit = rcDialog.querySelector<HTMLButtonElement>('[type=submit]')!;
  const same = !to || characterName(to) === from;
  submit.disabled = same;
  if (same) {
    $('#rc-preview').textContent = '';
    return;
  }
  const r = renameCharacter(editor.getBlocks(), from, to, { inText: rcInText.checked });
  let text = rcInText.checked ? t('rc.preview', { cues: r.cues, mentions: r.mentions }) : t('rc.previewCues', { cues: r.cues });
  const target = characterName(to);
  if ([...rcFrom.options].some((o) => o.value === target)) text += ' ' + t('rc.merge', { name: target });
  $('#rc-preview').textContent = text;
}

function openRenameChar(name?: string) {
  editor.flush();
  const chars = characterStats(editor.getBlocks());
  if (!chars.length) {
    toast(t('rc.none'));
    return;
  }
  rcFrom.innerHTML = chars
    .map((c) => `<option value="${esc(c.name)}">${esc(c.name)} — ${esc(t('char.lines', { n: c.dialogues }))}</option>`)
    .join('');
  const pick = name ?? speakerAtCursor();
  rcFrom.value = chars.some((c) => c.name === pick) ? pick : chars[0].name;
  rcTo.value = rcFrom.value;
  updateRenamePreview();
  rcDialog.showModal();
  rcTo.focus();
  rcTo.select();
}

rcFrom.addEventListener('change', () => {
  rcTo.value = rcFrom.value;
  updateRenamePreview();
  rcTo.focus();
  rcTo.select();
});
rcTo.addEventListener('input', updateRenamePreview);
rcInText.addEventListener('change', updateRenamePreview);
rcDialog.querySelector('[data-close]')!.addEventListener('click', () => rcDialog.close());
$<HTMLFormElement>('#form-rename-char').addEventListener('submit', () => {
  const from = rcFrom.value;
  const to = rcTo.value.trim();
  if (!to || characterName(to) === from) return;
  const r = renameCharacter(editor.getBlocks(), from, to, { inText: rcInText.checked });
  editor.replaceBlocks(r.blocks); // one undo step
  toast(t('rc.done', { from, to: to.toUpperCase() }));
});
$('#char-list').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-rename]');
  if (btn) openRenameChar(btn.dataset.rename);
});

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Importing a file creates a new project and opens it.
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  let id: string;
  try {
    id = await importFile(file);
  } catch {
    toast(t('toast.badFile'));
    return;
  }
  await saveNow();
  location.href = editorUrl(id);
});

async function newScript() {
  await saveNow();
  const id = await createProject({
    version: 1,
    titlePage: { ...emptyTitlePage(), credit: t('tp.credit') },
    blocks: [{ type: 'scene', text: '' }],
  });
  location.href = editorUrl(id);
}

async function goToProjects() {
  await saveNow();
  location.href = '/projects';
}

/* -------------------------------------------------------------------- */
/* Export (PDF / Fountain / TXT + optional statistics & character report) */
/* -------------------------------------------------------------------- */

type ExportFormat = 'pdf' | 'fountain' | 'txt' | 'terra';
interface ExportChoice {
  format: ExportFormat;
  script: boolean;
  title: boolean;
  stats: boolean;
  chars: boolean;
  takes: boolean;
}

const exportDialog = $<HTMLDialogElement>('#dlg-export');
const exportForm = $<HTMLFormElement>('#form-export');
const exportField = <T extends HTMLInputElement>(name: string) => exportForm.elements.namedItem(name) as T;

function readExportChoice(): ExportChoice {
  const fd = new FormData(exportForm);
  return {
    format: (fd.get('format') as ExportFormat) || 'pdf',
    script: fd.has('script'),
    title: fd.has('title') && !exportField('title').disabled,
    stats: fd.has('stats'),
    chars: fd.has('chars'),
    takes: fd.has('takes'),
  };
}

function updateExportDialog() {
  const c = readExportChoice();
  const note = $('#ex-note');
  const submit = exportForm.querySelector<HTMLButtonElement>('[type=submit]')!;
  const hasTitle = Boolean(titlePage.title.trim());
  exportField('title').disabled = !hasTitle;
  exportForm.querySelector('[data-desc-for=title]')!.textContent = t(hasTitle ? 'ex.titlePageDesc' : 'ex.titlePageEmpty');
  // .terra is always the complete project: the content options don't apply.
  const terra = c.format === 'terra';
  exportForm.querySelector<HTMLFieldSetElement>('.ex-checks')!.closest('fieldset')!.disabled = terra;
  if (terra) {
    submit.disabled = false;
    note.textContent = t('ex.terraNote');
    return;
  }
  const nothing = !c.script && !c.title && !c.stats && !c.chars && !c.takes;
  submit.disabled = nothing;
  if (nothing) note.textContent = t('ex.nothing');
  else if (c.stats || c.chars || c.takes) {
    const where = ({ pdf: 'ex.wherePdf', fountain: 'ex.whereFountain', txt: 'ex.whereTxt' } as Record<string, Key>)[c.format];
    note.textContent = t('ex.reportWhere', { where: t(where) });
  } else note.textContent = '';
}

function openExport(format?: ExportFormat) {
  editor.flush();
  const f = format ?? settings.exportFormat;
  for (const r of exportForm.querySelectorAll<HTMLInputElement>('[name=format]')) r.checked = r.value === f;
  exportField('script').checked = settings.exportScript;
  exportField('title').checked = settings.includeTitlePage;
  exportField('stats').checked = settings.exportStats;
  exportField('chars').checked = settings.exportChars;
  exportField('takes').checked = settings.exportTakes;
  updateExportDialog();
  exportDialog.showModal();
  // Start keyboard focus on the selected format, not simply the first one.
  exportForm.querySelector<HTMLInputElement>('[name=format]:checked')?.focus();
}

exportForm.addEventListener('change', updateExportDialog);
exportForm.querySelector('[data-close]')!.addEventListener('click', () => exportDialog.close());
exportForm.addEventListener('submit', () => {
  const c = readExportChoice();
  Object.assign(settings, { exportFormat: c.format });
  if (c.format !== 'terra')
    Object.assign(settings, {
      exportScript: c.script,
      includeTitlePage: exportField('title').checked,
      exportStats: c.stats,
      exportChars: c.chars,
      exportTakes: c.takes,
    });
  save(SETTINGS_KEY, settings);
  runExport(c);
});

function runExport(c: ExportChoice) {
  editor.flush();
  const blocks = editor.getBlocks();
  const tp = c.title && titlePage.title.trim() ? titlePage : undefined;
  const report =
    c.stats || c.chars || c.takes
      ? buildReport(blocks, { stats: c.stats, characters: c.chars, takes: c.takes, title: titlePage.title, paper: settings.paper, locale: locale() })
      : null;
  const file = `${fileBase()}.${c.format}`;
  try {
    if (c.format === 'terra') {
      downloadTerra();
      return;
    } else if (c.format === 'pdf') {
      const blob = buildPdf(blocks, { paper: settings.paper, sceneNumbers: settings.sceneNumbers, titlePage: tp, script: c.script, report });
      downloadBlob(file, blob);
    } else {
      const parts: string[] = [];
      if (c.format === 'fountain') {
        parts.push(toFountain(c.script ? blocks : [], tp).trimEnd());
        // Boneyard /* */ keeps the report out of the screenplay when re-opened.
        if (report) parts.push(`/*\n${reportToText(report).replace(/\*\//g, '* /')}\n*/`);
      } else {
        parts.push(toPlainText(c.script ? blocks : [], tp).trimEnd());
        if (report) parts.push(reportToText(report));
      }
      download(file, parts.filter(Boolean).join(c.format === 'txt' ? '\n\n\f\n' : '\n\n') + '\n', 'text/plain');
    }
    toast(t('ex.done', { file }));
  } catch (err) {
    console.error(err);
    toast(t('toast.pdfFail'));
  }
}

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function printScript() {
  editor.flush();
  const root = $('#print-root');
  root.innerHTML = buildPrintHtml(editor.getBlocks(), exportTitle() ?? emptyTitlePage(), { sceneNumbers: settings.sceneNumbers });
  $('#page-style').textContent = `@page { size: ${settings.paper === 'a4' ? 'A4' : 'letter'}; }`;
  window.print();
}

/* -------------------------------------------------------------------- */
/* Dialogs                                                               */
/* -------------------------------------------------------------------- */

/* Title page sheet: fields edited in place on a page above the script. */
const titleSheet = $('#title-sheet');
const tpFields = $$<HTMLTextAreaElement>('[data-tp]');

function syncTitleUI() {
  titleInput.value = titlePage.title;
  for (const f of tpFields) f.value = titlePage[f.dataset.tp as keyof TitlePage] ?? '';
}

function titleChanged() {
  changeVersion++;
  updateDocTitle();
  saveStatus.textContent = t('save.saving');
  window.clearTimeout(changeTimer);
  changeTimer = window.setTimeout(persist, 400);
}

for (const f of tpFields) {
  f.addEventListener('input', () => {
    const key = f.dataset.tp as keyof TitlePage;
    // Title and draft date are single-line; the others may span lines.
    if (key === 'title' || key === 'draftDate' || key === 'credit') f.value = f.value.replace(/\n/g, ' ');
    titlePage[key] = f.value;
    if (key === 'title') titleInput.value = f.value;
    titleChanged();
  });
  f.addEventListener('keydown', (e) => {
    const single = ['title', 'credit', 'draftDate'].includes(f.dataset.tp!);
    if (e.key === 'Enter' && single) {
      e.preventDefault();
      const next = tpFields[tpFields.indexOf(f) + 1];
      next ? next.focus() : editor.focus(0, 0);
    }
  });
}

function openTitlePage() {
  if (!settings.showTitlePage) {
    settings.showTitlePage = true;
    applySettings();
  }
  titleSheet.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const title = tpFields[0];
  title.focus({ preventScroll: true });
  title.setSelectionRange(title.value.length, title.value.length);
}

/** Title page to include in exports, or undefined when switched off/empty. */
function exportTitle(): TitlePage | undefined {
  return settings.includeTitlePage && titlePage.title.trim() ? titlePage : undefined;
}

titleInput.addEventListener('input', () => {
  titlePage.title = titleInput.value;
  tpFields[0].value = titleInput.value;
  titleChanged();
});
titleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    editor.focus();
  }
});

for (const d of $$<HTMLDialogElement>('dialog')) {
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  });
  d.addEventListener('close', () => editor.focus());
}

let toastTimer: number | undefined;
function toast(msg: string) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 3500);
}

/* -------------------------------------------------------------------- */
/* Menus                                                                 */
/* -------------------------------------------------------------------- */

const actions: Record<string, () => void> = {
  new: newScript,
  open: () => fileInput.click(),
  'save-terra': () => {
    downloadTerra();
  },
  export: () => openExport(),
  print: printScript,
  projects: goToProjects,
  'title-page': openTitlePage,
  'toggle-title-sheet': () => {
    settings.showTitlePage = !settings.showTitlePage;
    applySettings();
  },
  undo: () => editor.undo(),
  redo: () => editor.redo(),
  'select-all': () => {
    editor.focus();
    const r = document.createRange();
    r.selectNodeContents(editorEl);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  },
  dual,
  'toggle-scene-numbers': () => {
    settings.sceneNumbers = !settings.sceneNumbers;
    layoutChanged();
    if (settings.view === 'cards') board.render();
  },
  'toggle-page-markers': () => {
    settings.pageMarkers = !settings.pageMarkers;
    applySettings();
  },
  'toggle-sidebar': () => {
    settings.sidebar = !settings.sidebar;
    applySettings();
    applyZoom();
    layoutPages();
  },
  'theme-light': () => setTheme('light'),
  'theme-dark': () => setTheme('dark'),
  'theme-system': () => setTheme('system'),
  'paper-color-auto': () => ((settings.paperColor = 'auto'), applySettings()),
  'paper-color-light': () => ((settings.paperColor = 'light'), applySettings()),
  'paper-color-dark': () => ((settings.paperColor = 'dark'), applySettings()),
  'lang-en': () => applyLanguage('en'),
  'lang-id': () => applyLanguage('id'),
  'paper-letter': () => ((settings.paper = 'letter'), layoutChanged()),
  'paper-a4': () => ((settings.paper = 'a4'), layoutChanged()),
  takes: toggleTakes,
  'rename-char': () => openRenameChar(),
  'view-script': () => setView('script'),
  'view-cards': () => setView('cards'),
  'zoom-in': () => setZoom(settings.zoom + 0.1),
  'zoom-out': () => setZoom(settings.zoom - 0.1),
  'zoom-reset': () => setZoom(1),
  'report-scenes': () => showReport('scenes'),
  'report-characters': () => showReport('characters'),
  'report-stats': () => showReport('stats'),
  shortcuts: () => $<HTMLDialogElement>('#dlg-help').showModal(),
  about: () => $<HTMLDialogElement>('#dlg-about').showModal(),
  'load-sample': () => {
    if (confirm(t('confirm.sample'))) openSample();
  },
};
for (const el of ELEMENTS) actions[`type-${el.type}`] = () => editor.setType(el.type);

function showReport(tab: Settings['sidebarTab']) {
  settings.sidebar = true;
  applySettings();
  setSidebarTab(tab);
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
  editor.closeSuggestions();
  openMenu = menu;
  menu.classList.add('open');
  menu.querySelector('[data-menu-btn]')?.setAttribute('aria-expanded', 'true');
}

for (const menu of $$('[data-menu]')) {
  const btn = menu.querySelector<HTMLElement>('[data-menu-btn]')!;
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => (openMenu === menu ? closeMenus() : showMenu(menu)));
  btn.addEventListener('mouseenter', () => openMenu && showMenu(menu));
}
for (const item of $$('[data-action]')) {
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
/* Global shortcuts                                                      */
/* -------------------------------------------------------------------- */

const KEY_TYPES = new Map(ELEMENTS.filter((e) => e.key).map((e) => [e.key!, e.type]));

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape' && openMenu) {
    closeMenus();
    return;
  }
  const inField = (e.target as HTMLElement | null)?.closest?.('input, textarea, select');
  if (e.altKey && !mod && e.code === 'KeyT') {
    e.preventDefault();
    toggleTakes();
    return;
  }
  if (e.altKey && !mod && !inField) {
    const digit = e.code.startsWith('Digit') ? e.code.slice(5) : null;
    if (digit && KEY_TYPES.has(digit)) {
      e.preventDefault();
      editor.setType(KEY_TYPES.get(digit)!);
      return;
    }
    if (e.code === 'KeyD') {
      e.preventDefault();
      dual();
      return;
    }
  }
  if (!mod || e.altKey) return;
  const k = e.key.toLowerCase();
  // In card view the editor isn't focused, so handle undo/redo here
  // (text fields inside cards keep their own native undo).
  if (e.key === '\\') {
    e.preventDefault();
    actions['toggle-sidebar']();
    return;
  }
  if (settings.view === 'cards' && !inField && (k === 'z' || k === 'y')) {
    e.preventDefault();
    if (k === 'y' || e.shiftKey) editor.redo();
    else editor.undo();
    board.render();
    return;
  }
  if (k === 's') {
    e.preventDefault();
    editor.flush();
    persist();
    toast(t(e.shiftKey ? 'toast.downloading' : 'toast.saved'));
    if (e.shiftKey) actions['save-terra']();
  } else if (k === 'e' && e.shiftKey) {
    e.preventDefault();
    openExport();
  } else if (k === 'o') {
    e.preventDefault();
    fileInput.click();
  } else if (k === 'p') {
    e.preventDefault();
    printScript();
  } else if (k === '=' || k === '+') {
    e.preventDefault();
    setZoom(settings.zoom + 0.1);
  } else if (k === '-') {
    e.preventDefault();
    setZoom(settings.zoom - 0.1);
  } else if (k === '/') {
    e.preventDefault();
    actions.shortcuts();
  }
});

// IndexedDB writes may not finish while the page is closing, so keep a
// synchronous localStorage snapshot that the next load picks up.
window.addEventListener('pagehide', () => {
  editor.flush();
  if (projectId && changeVersion !== savedVersion) {
    writeUnsaved(projectId, currentDoc());
    persist();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveNow();
});
window.addEventListener('beforeunload', () => {
  editor.flush();
  if (projectId && changeVersion !== savedVersion) {
    // No "leave page?" prompt: this snapshot is restored on the next visit.
    writeUnsaved(projectId, currentDoc());
    persist();
  }
});

// The logo goes back to the project list; save first.
$('.home-link').addEventListener('click', (e) => {
  e.preventDefault();
  goToProjects();
});

/* -------------------------------------------------------------------- */
/* Boot                                                                  */
/* -------------------------------------------------------------------- */

async function boot() {
  applyLanguage(settings.lang);
  setSidebarTab(settings.sidebarTab);
  if (!projectId) {
    location.replace('/projects');
    return;
  }
  try {
    await migrateLegacy();
    const p = await loadProject(projectId);
    if (!p) {
      location.replace('/projects?missing=1');
      return;
    }
    const unsaved = takeUnsaved(projectId, p.meta.updatedAt);
    if (unsaved) replaceDoc(unsaved);
    else openDoc(p.doc);
    lastSavedAt = new Date(p.meta.updatedAt);
    renderSaveStatus();
    showStorageNotices(p.meta);
  } catch (err) {
    console.error(err);
    saveFailed = true;
    renderSaveStatus();
    toast(t('proj.storageError'));
    openDoc({ titlePage: { ...emptyTitlePage(), credit: t('tp.credit') }, blocks: [{ type: 'scene', text: '' }] });
  }
  setView(settings.view);
  hideLoader();
  document.fonts?.ready.then(layoutPages);
}
boot();
