import {
  createProject,
  addSongsToAlbum,
  createAlbum,
  createSong,
  deleteProject,
  duplicateProject,
  editorUrl,
  importFile,
  isAlbum,
  isMusic,
  isSong,
  listProjects,
  loadProject,
  loadAlbum,
  loadSong,
  getImage,
  imagesAsDataUrls,
  markBackedUp,
  migrateLegacy,
  needsBackup,
  renameProject,
  projectUrl,
  serializeProject,
  songUrl,
  type ProjectMeta,
} from './projects';
import { emptyAlbum, emptySong, sampleSong, serializeAlbum, serializeSong, type SongLang } from './song';
import { chooseNewKind, pickAlbumFor } from './music-dialogs';
import { applyI18n, getLang, sampleScript, setLang, t, type Lang } from './i18n';
import { emptyTitlePage } from './types';
import { saveFile } from './save-file';
import { initDesktopPromo } from './desktop-promo';
import { hideLoader, initThemeSwitches, showLoader, syncThemeSwitches, themeTransition } from './ui-effects';

/* -------------------------------------------------------------------- */
/* Settings shared with the editor                                       */
/* -------------------------------------------------------------------- */

const SETTINGS_KEY = 'tewrite:settings';
type Sort = 'recent' | 'created' | 'title';

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

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const locale = () => (getLang() === 'id' ? 'id-ID' : 'en-US');

const settings = readSettings();
setLang((settings.lang as Lang) || 'en');
let sort: Sort = (['recent', 'created', 'title'] as Sort[]).includes(settings.projectSort as Sort)
  ? (settings.projectSort as Sort)
  : 'recent';
let query = '';
let projects: ProjectMeta[] = [];

/* Screenplays and songs each have their own tab (?tab=song opens the songs). */
type Tab = 'script' | 'song';
const urlTab = new URLSearchParams(location.search).get('tab');
let tab: Tab = urlTab === 'song' || urlTab === 'script' ? urlTab : settings.projectTab === 'song' ? 'song' : 'script';
const inTab = (p: ProjectMeta) => (tab === 'song') === isMusic(p);
const songLang = (): SongLang => (getLang() === 'id' ? 'id' : 'en');

/* -------------------------------------------------------------------- */
/* Theme & language                                                      */
/* -------------------------------------------------------------------- */

const media = window.matchMedia('(prefers-color-scheme: dark)');
const isDark = () => document.documentElement.classList.contains('dark');

initThemeSwitches((dark, source) =>
  themeTransition(() => {
    document.documentElement.classList.toggle('dark', dark);
    writeSettings({ theme: dark ? 'dark' : 'light' });
    syncThemeSwitches();
  }, source),
);
media.addEventListener('change', () => {
  if ((readSettings().theme ?? 'system') === 'system') document.documentElement.classList.toggle('dark', media.matches);
  syncThemeSwitches();
});

const langSelect = $<HTMLSelectElement>('#lang-select');
langSelect.value = getLang();
langSelect.addEventListener('change', () => {
  setLang(langSelect.value as Lang);
  writeSettings({ lang: getLang() });
  translate();
  render();
});

function translate() {
  applyI18n();
  document.title = t('proj.pageTitle');
  document.documentElement.classList.remove('i18n-pending');
}

/* -------------------------------------------------------------------- */
/* Rendering                                                             */
/* -------------------------------------------------------------------- */

function relTime(ts: number): string {
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const s = Math.round((ts - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return rtf.format(0, 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A project's name, or the right 'untitled' for its kind (script, song, album / EP). */
const untitled = (p: ProjectMeta) => t(isAlbum(p) ? 'mus.albumUntitled' : isSong(p) ? 'song.untitled' : 'proj.untitled');
const displayTitle = (p: ProjectMeta) => p.title || untitled(p);

function visibleProjects(): ProjectMeta[] {
  const q = query.trim().toLowerCase();
  const mine = projects.filter(inTab);
  const list = q ? mine.filter((p) => displayTitle(p).toLowerCase().includes(q) || p.author.toLowerCase().includes(q)) : mine;
  if (sort === 'recent') list.sort((a, b) => b.updatedAt - a.updatedAt);
  else if (sort === 'created') list.sort((a, b) => b.createdAt - a.createdAt);
  else list.sort((a, b) => displayTitle(a).localeCompare(displayTitle(b), locale(), { sensitivity: 'base' }));
  return list;
}

const MORE_ICON =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

/** Backup status line: warns when the project only lives in this browser. */
function backupBadge(p: ProjectMeta): string {
  if (needsBackup(p)) {
    const label = p.backedUpAt ? t('proj.bkStale') : t('proj.bkNever');
    return `<p class="proj-bk is-warn"><i aria-hidden="true"></i>${esc(label)}</p>`;
  }
  if (p.backedUpAt) return `<p class="proj-bk is-ok"><i aria-hidden="true"></i>${esc(t('proj.bkOk', { time: relTime(p.backedUpAt) }))}</p>`;
  return '';
}

function card(p: ProjectMeta): string {
  const title = displayTitle(p);
  const song = isSong(p);
  const album = isAlbum(p);
  let stats: string;
  if (album) {
    const kind = t(p.albumType === 'ep' ? 'mus.kind.ep' : 'mus.kind.album');
    stats = `${kind} · ${t(p.tracks === 1 ? 'mus.track1' : 'mus.tracks', { n: p.tracks ?? 0 })}`;
  } else if (song) {
    const secs = t(p.sections === 1 ? 'song.section1' : 'song.sections', { n: p.sections ?? 0 });
    const lines = t(p.lines === 1 ? 'song.line1' : 'song.lines', { n: p.lines ?? 0 });
    stats = `${secs} · ${lines}`;
  } else {
    const pages = t(p.pages === 1 ? 'st.page' : 'st.pages', { n: p.pages });
    const scenes = p.scenes === 1 ? t('proj.scene1') : t('proj.scenes', { n: p.scenes });
    stats = `${pages} · ${scenes}`;
  }
  // A song's thumbnail is a little lyric sheet: note, title, writer, lines of lyrics.
  // An album's thumbnail is a record sleeve with the disc peeking out (a single with cover art too).
  const kindLabel = t(album ? (p.albumType === 'ep' ? 'mus.kind.ep' : 'mus.kind.album') : 'mus.kind.single');
  const coverImg = p.cover ? `<img class="thumb-cover" data-cover="${esc(p.id)}" data-cover-id="${esc(p.cover)}" alt="" hidden>` : '';
  const thumb = album || (song && p.cover)
    ? `<div class="thumb-album${p.albumType === 'ep' ? ' is-ep' : ''}${p.cover ? ' has-cover' : ''}">
          <span class="thumb-disc"></span>
          <span class="thumb-sleeve">
            ${coverImg}
            <span class="thumb-kind">${esc(kindLabel)}</span>
            <span class="thumb-title${p.title ? '' : ' is-empty'}">${esc(title)}</span>
            ${p.author ? `<span class="thumb-author">${esc(p.author)}</span>` : ''}
          </span>
        </div>`
    : song
    ? `<div class="thumb-page thumb-song">
          <span class="thumb-note">♪</span>
          <span class="thumb-title${p.title ? '' : ' is-empty'}">${esc(title)}</span>
          ${p.author ? `<span class="thumb-author">${esc(p.author)}</span>` : ''}
          <span class="thumb-lyrics"><i></i><i></i><i></i><i></i></span>
        </div>`
    : `<div class="thumb-page">
          <span class="thumb-title${p.title ? '' : ' is-empty'}">${esc(p.title ? p.title.toUpperCase() : title)}</span>
          ${p.author ? `<span class="thumb-by">${esc(t('tp.credit'))}</span><span class="thumb-author">${esc(p.author)}</span>` : ''}
        </div>`;
  return `<li class="proj-card" data-id="${esc(p.id)}">
    <a class="proj-open" href="${projectUrl(p)}">
      <div class="proj-thumb" aria-hidden="true">
        ${thumb}
      </div>
      <div class="proj-info">
        <h2 class="proj-name">${esc(title)}</h2>
        <p class="proj-meta">${esc(t('proj.edited', { time: relTime(p.updatedAt) }))}</p>
        <p class="proj-meta">${esc(stats)}</p>
        ${backupBadge(p)}
      </div>
    </a>
    <button type="button" class="proj-more" data-more="${esc(p.id)}" aria-haspopup="menu" aria-label="${esc(t('proj.more', { name: title }))}">${MORE_ICON}</button>
  </li>`;
}

function render() {
  const grid = $('#proj-grid');
  const empty = $('#proj-empty');
  const tools = $('#proj-tools');
  const list = visibleProjects();
  const total = projects.filter(inTab).length;
  const songs = projects.filter(isMusic).length;

  for (const b of document.querySelectorAll<HTMLElement>('[data-ptab]')) b.setAttribute('aria-selected', String(b.dataset.ptab === tab));
  $('[data-ptab-count="script"]').textContent = String(projects.length - songs);
  $('[data-ptab-count="song"]').textContent = String(songs);
  for (const el of document.querySelectorAll('[data-new-label]')) el.textContent = t(tab === 'song' ? 'song.new' : 'proj.newScript');
  $('#empty-title').textContent = t(tab === 'song' ? 'song.empty' : 'proj.empty');
  $('#empty-hint').textContent = t(tab === 'song' ? 'song.emptyHint' : 'proj.emptyHint');
  $('#btn-empty-sample').textContent = t(tab === 'song' ? 'song.sample' : 'proj.sample');

  tools.hidden = total === 0;
  empty.hidden = total !== 0;
  $('#proj-count').textContent =
    total === 1 ? t('proj.count1') : t('proj.count', { n: total });

  if (!total) {
    grid.innerHTML = '';
    return;
  }
  const newTile = `<li><button type="button" class="proj-new" data-new>
      <span class="proj-new-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></span>
      <span>${esc(t(tab === 'song' ? 'song.new' : 'proj.newScript'))}</span></button></li>`;
  grid.innerHTML = list.length
    ? (query ? '' : newTile) + list.map(card).join('')
    : `<li class="proj-nomatch">${esc(t('proj.noMatch', { q: query }))}</li>`;
  void loadCardCovers();
}

/** Cover art on song and album cards, loaded from the image store (cached by project + image id). */
const coverUrls = new Map<string, string>();
async function loadCardCovers() {
  for (const img of document.querySelectorAll<HTMLImageElement>('img[data-cover-id]')) {
    const key = `${img.dataset.cover}/${img.dataset.coverId}`;
    let url = coverUrls.get(key);
    if (!url) {
      const blob = await getImage(img.dataset.cover!, img.dataset.coverId!).catch(() => undefined);
      if (!blob) continue;
      url = URL.createObjectURL(blob);
      coverUrls.set(key, url);
    }
    img.src = url;
    img.hidden = false;
  }
}

async function refresh() {
  try {
    projects = await listProjects();
    $('#proj-error').hidden = true;
  } catch (err) {
    console.error(err);
    projects = [];
    $('#proj-error').hidden = false;
  }
  render();
}

/* -------------------------------------------------------------------- */
/* Actions                                                               */
/* -------------------------------------------------------------------- */

async function newProject() {
  showLoader();
  try {
    if (tab === 'song') {
      // A single, an album or an EP?
      hideLoader();
      const kind = await chooseNewKind();
      if (!kind) return;
      showLoader();
      location.href = songUrl(kind === 'single' ? await createSong(emptySong(songLang())) : await createAlbum(emptyAlbum(kind, songLang())));
      return;
    }
    const id = await createProject({
      version: 1,
      titlePage: { ...emptyTitlePage(), credit: t('tp.credit') },
      blocks: [{ type: 'scene', text: '' }],
    });
    location.href = editorUrl(id);
  } catch {
    hideLoader();
    toast(t('proj.storageError'));
  }
}

async function openSample() {
  showLoader();
  try {
    if (tab === 'song') {
      location.href = songUrl(await createSong(sampleSong(songLang())));
      return;
    }
    const id = await createProject({
      version: 1,
      titlePage: { ...emptyTitlePage(), title: t('sample.title'), credit: t('tp.credit'), author: t('sample.author') },
      blocks: sampleScript(getLang()),
    });
    location.href = editorUrl(id);
  } catch {
    hideLoader();
    toast(t('proj.storageError'));
  }
}

const fileInput = $<HTMLInputElement>('#file-input');
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  if (/\.pdf$/i.test(file.name)) toast(t('toast.reading', { file: file.name }));
  try {
    location.href = await importFile(file);
  } catch (err) {
    console.error(err);
    toast(t((err as Error)?.name === 'PdfNoTextError' ? 'toast.pdfNoText' : 'toast.badFile'));
  }
});

async function downloadProject(id: string) {
  const song = await loadSong(id);
  const album = song ? null : await loadAlbum(id);
  if (song || album) {
    const name = ((song ? song.doc.title : album!.doc.title).trim() || t('file.default')).replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-').toLowerCase();
    // The cover art travels inside the file.
    const images = await imagesAsDataUrls(id, [song ? song.doc.cover : album!.doc.cover]);
    const data = song ? serializeSong(song.doc, images) : serializeAlbum(album!.doc, images);
    if (!(await saveFile(`${name}.terra`, data, 'application/json'))) return;
    await markBackedUp(id);
    toast(t('bk.saved'));
    await refresh();
    return;
  }
  const p = await loadProject(id);
  if (!p) return;
  const name = (p.doc.titlePage.title.trim() || t('file.default')).replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-').toLowerCase();
  if (!(await saveFile(`${name}.terra`, await serializeProject(id, p.doc), 'application/json'))) return;
  await markBackedUp(id);
  toast(t('bk.saved'));
  await refresh();
}

const renameDialog = $<HTMLDialogElement>('#dlg-rename');
const renameInput = $<HTMLInputElement>('#rename-input');
let renameId: string | null = null;

function openRename(p: ProjectMeta) {
  renameId = p.id;
  renameInput.value = p.title;
  renameDialog.showModal();
  renameInput.select();
}
renameDialog.querySelector('[data-close]')!.addEventListener('click', () => renameDialog.close());
$<HTMLFormElement>('#form-rename').addEventListener('submit', async () => {
  if (!renameId) return;
  await renameProject(renameId, renameInput.value.trim());
  await refresh();
});

async function removeProject(p: ProjectMeta) {
  if (!confirm(t('proj.confirmDelete', { name: displayTitle(p) }))) return;
  await deleteProject(p.id);
  toast(t('proj.deleted', { name: displayTitle(p) }));
  await refresh();
}

/* Card "more" menu */
const cardMenu = $('#card-menu');
let menuFor: ProjectMeta | null = null;

function openCardMenu(btn: HTMLElement, p: ProjectMeta) {
  menuFor = p;
  // "Put into an album / EP" is only for singles.
  cardMenu.querySelector<HTMLElement>('[data-card-action="to-album"]')!.hidden = !isSong(p);
  cardMenu.hidden = false;
  const r = btn.getBoundingClientRect();
  const w = cardMenu.offsetWidth;
  const h = cardMenu.offsetHeight;
  cardMenu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  cardMenu.style.top = `${r.bottom + h + 8 > window.innerHeight ? r.top - h - 4 : r.bottom + 4}px`;
  btn.setAttribute('aria-expanded', 'true');
  (cardMenu.querySelector('button') as HTMLButtonElement).focus();
}
function closeCardMenu() {
  if (cardMenu.hidden) return;
  cardMenu.hidden = true;
  document.querySelector('[data-more][aria-expanded="true"]')?.setAttribute('aria-expanded', 'false');
  menuFor = null;
}

cardMenu.addEventListener('click', async (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>('[data-card-action]')?.dataset.cardAction;
  const p = menuFor;
  closeCardMenu();
  if (!p || !action) return;
  if (action === 'open') location.href = projectUrl(p);
  else if (action === 'rename') openRename(p);
  else if (action === 'duplicate') {
    await duplicateProject(p.id, (title) => t('proj.copy', { name: title || untitled(p) }));
    await refresh();
  } else if (action === 'download') downloadProject(p.id);
  else if (action === 'to-album') putInAlbum(p);
  else if (action === 'delete') removeProject(p);
});

/** A single goes into an album / EP (existing or new): copied, or moved when asked. */
async function putInAlbum(p: ProjectMeta) {
  const choice = await pickAlbumFor(displayTitle(p));
  if (!choice) return;
  try {
    const albumId = choice.albumId ?? (await createAlbum({ ...emptyAlbum(choice.newType, songLang(), choice.newTitle), tracks: [] }));
    await addSongsToAlbum(albumId, [p.id], choice.move);
    const album = projects.find((x) => x.id === albumId);
    toast(t(choice.move ? 'mus.movedTo' : 'mus.copiedTo', { name: displayTitle(p), album: album ? displayTitle(album) : choice.newTitle }));
  } catch (err) {
    console.error(err);
    toast(t('proj.storageError'));
  }
  await refresh();
}

$('#proj-grid').addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('[data-new]')) return void newProject();
  const more = target.closest<HTMLElement>('[data-more]');
  if (more) {
    e.preventDefault();
    const p = projects.find((x) => x.id === more.dataset.more);
    if (!p) return;
    if (menuFor?.id === p.id) closeCardMenu();
    else openCardMenu(more, p);
  }
});

document.addEventListener('mousedown', (e) => {
  const el = e.target as HTMLElement;
  if (!cardMenu.hidden && !cardMenu.contains(el) && !el.closest('[data-more]')) closeCardMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCardMenu();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    fileInput.click();
  }
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault();
    $('#proj-search').focus();
  }
});
window.addEventListener('resize', closeCardMenu);
window.addEventListener('scroll', closeCardMenu, true);

$('#btn-new').addEventListener('click', newProject);
for (const b of document.querySelectorAll<HTMLElement>('[data-ptab]')) {
  b.addEventListener('click', () => {
    tab = b.dataset.ptab as Tab;
    writeSettings({ projectTab: tab });
    history.replaceState(null, '', tab === 'song' ? '/projects?tab=song' : '/projects');
    render();
  });
}
$('#btn-import').addEventListener('click', () => fileInput.click());
$('#btn-empty-new').addEventListener('click', newProject);
$('#btn-empty-import').addEventListener('click', () => fileInput.click());
$('#btn-empty-sample').addEventListener('click', openSample);

const search = $<HTMLInputElement>('#proj-search');
search.addEventListener('input', () => {
  query = search.value;
  render();
});
const sortSelect = $<HTMLSelectElement>('#proj-sort');
sortSelect.value = sort;
sortSelect.addEventListener('change', () => {
  sort = sortSelect.value as Sort;
  writeSettings({ projectSort: sort });
  render();
});

let toastTimer: number | undefined;
function toast(msg: string) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 3500);
}

// Coming back with the browser's back button: show fresh data.
window.addEventListener('pageshow', (e) => {
  if (e.persisted) refresh();
});
// Another tab saved a project: keep relative times and stats current.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});

/* -------------------------------------------------------------------- */
/* Boot                                                                  */
/* -------------------------------------------------------------------- */

(async () => {
  translate();
  initDesktopPromo();
  const params = new URLSearchParams(location.search);
  if (params.has('missing')) {
    toast(t('proj.missing'));
    history.replaceState(null, '', '/projects');
  }
  try {
    await migrateLegacy();
  } catch {
    /* shown by refresh() */
  }
  await refresh();
  hideLoader();
})();
