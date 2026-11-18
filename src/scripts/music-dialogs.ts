/**
 * Dialogs shared by the project list and the song editor:
 *  - new song: a single, an album or an EP;
 *  - put a single into an album / EP (an existing one or a new one);
 *  - pick singles to add to an album.
 * Each returns the choice (or null when cancelled); the caller does the work.
 */
import { t, type Key } from './i18n';
import { isAlbum, isSong, listProjects, type ProjectMeta } from './projects';
import type { AlbumType } from './song';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const title = (p: ProjectMeta, untitled: string) => p.title || untitled;

/** Show a dialog built from `html`; resolves with `read(form)` on submit, null on cancel. */
function ask<T>(html: string, read: (form: HTMLFormElement) => T | null, wide = false): Promise<T | null> {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = `dialog music-dialog${wide ? ' dialog-wide' : ''}`;
    d.innerHTML = html;
    document.body.appendChild(d);
    const form = d.querySelector('form')!;
    let result: T | null = null;
    form.addEventListener('submit', (e) => {
      const value = read(form);
      if (value === null) {
        e.preventDefault();
        return;
      }
      result = value;
    });
    d.querySelector('[data-close]')?.addEventListener('click', () => d.close());
    d.addEventListener('close', () => {
      d.remove();
      resolve(result);
    });
    d.showModal();
    d.querySelector<HTMLElement>('[autofocus]')?.focus();
  });
}

const buttons = (go: string) => `<div class="flex justify-end gap-2 pt-1">
  <button type="button" class="btn" data-close>${esc(t('proj.cancel'))}</button>
  <button type="submit" class="btn btn-primary" value="ok"><span>${esc(go)}</span></button>
</div>`;

const ICONS = {
  single: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  album: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3a9 9 0 0 1 9 9"/></svg>',
  ep: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.8"/></svg>',
};

export type NewKind = 'single' | AlbumType;

/** "What are you writing?" — a single, an album or an EP. */
export function chooseNewKind(): Promise<NewKind | null> {
  const opt = (k: NewKind, checked = false) => `<label class="kind-card">
    <input type="radio" name="kind" value="${k}"${checked ? ' checked' : ''}>
    <span class="kind-icon">${ICONS[k]}</span>
    <span class="kind-text"><b>${esc(t(`mus.kind.${k}` as Key))}</b><span>${esc(t(`mus.kind.${k}Desc` as Key))}</span></span>
  </label>`;
  return ask(
    `<form method="dialog" class="grid gap-3">
      <h2 class="text-lg font-semibold">${esc(t('mus.newTitle'))}</h2>
      <div class="kind-cards">${opt('single', true)}${opt('album')}${opt('ep')}</div>
      ${buttons(t('mus.create'))}
    </form>`,
    (f) => (new FormData(f).get('kind') as NewKind) ?? null,
    true,
  );
}

export interface AlbumChoice {
  /** An existing album, or null to make a new one with `newTitle` / `newType`. */
  albumId: string | null;
  newTitle: string;
  newType: AlbumType;
  /** Remove the single afterwards (the song then lives only in the album). */
  move: boolean;
}

/** Choose the album / EP a single goes into. */
export async function pickAlbumFor(songTitle: string): Promise<AlbumChoice | null> {
  const albums = (await listProjects()).filter(isAlbum);
  const typeLabel = (p: ProjectMeta) => t(p.albumType === 'ep' ? 'mus.kind.ep' : 'mus.kind.album');
  const rows = albums
    .map(
      (a, i) => `<label class="pick-row"><input type="radio" name="album" value="${esc(a.id)}"${i === 0 ? ' checked' : ''}>
        <span class="pick-main">${esc(title(a, t('mus.albumUntitled')))}</span>
        <span class="pick-sub">${esc(typeLabel(a))} · ${esc(t((a.tracks ?? 0) === 1 ? 'mus.track1' : 'mus.tracks', { n: a.tracks ?? 0 }))}</span></label>`,
    )
    .join('');
  return ask(
    `<form method="dialog" class="grid gap-3">
      <h2 class="text-lg font-semibold">${esc(t('mus.toAlbumTitle'))}</h2>
      <p class="text-sm text-muted">${esc(t('mus.toAlbumBody', { name: songTitle }))}</p>
      <div class="pick-list">
        ${rows}
        <label class="pick-row"><input type="radio" name="album" value=""${albums.length ? '' : ' checked'}>
          <span class="pick-main">${esc(t('mus.newAlbum'))}</span></label>
        <div class="pick-new">
          <label><span>${esc(t('mus.newAlbumName'))}</span><input class="text-input" name="newTitle" placeholder=" " maxlength="120" autocomplete="off"></label>
          <label><span>${esc(t('mus.type'))}</span><select class="text-input" name="newType"><option value="album">${esc(t('mus.kind.album'))}</option><option value="ep">${esc(t('mus.kind.ep'))}</option></select></label>
        </div>
      </div>
      <label class="rc-check"><input type="checkbox" name="move"><span>${esc(t('mus.moveSingle'))}</span></label>
      ${buttons(t('mus.addToAlbum'))}
    </form>`,
    (f) => {
      const data = new FormData(f);
      const albumId = String(data.get('album') ?? '') || null;
      const newTitle = String(data.get('newTitle') ?? '').trim();
      if (!albumId && !newTitle) {
        f.querySelector<HTMLInputElement>('[name="newTitle"]')?.focus();
        return null;
      }
      return { albumId, newTitle, newType: data.get('newType') === 'ep' ? 'ep' : 'album', move: data.get('move') === 'on' };
    },
  );
}

/** Choose singles to add to an album. */
export async function pickSingles(): Promise<{ ids: string[]; move: boolean } | 'none' | null> {
  const singles = (await listProjects()).filter(isSong);
  if (!singles.length) return 'none';
  const rows = singles
    .map(
      (s) => `<label class="pick-row"><input type="checkbox" name="song" value="${esc(s.id)}">
        <span class="pick-main">${esc(title(s, t('song.untitled')))}</span>
        <span class="pick-sub">${esc(t((s.lines ?? 0) === 1 ? 'song.line1' : 'song.lines', { n: s.lines ?? 0 }))}</span></label>`,
    )
    .join('');
  return ask(
    `<form method="dialog" class="grid gap-3">
      <h2 class="text-lg font-semibold">${esc(t('mus.addSinglesTitle'))}</h2>
      <div class="pick-list">${rows}</div>
      <label class="rc-check"><input type="checkbox" name="move"><span>${esc(t('mus.moveSingles'))}</span></label>
      ${buttons(t('mus.addToAlbum'))}
    </form>`,
    (f) => {
      const data = new FormData(f);
      const ids = data.getAll('song').map(String);
      return ids.length ? { ids, move: data.get('move') === 'on' } : null;
    },
  );
}
