/**
 * Wardrobe: costume changes per character ("Change 1", "Wedding dress"…), each
 * with a reference photo and the scenes it is worn in. The call sheet lists
 * the costumes needed on a day.
 */
import { newId } from './projects';
import { ICON, button, esc, field, iconButton, tk, type ProdApi, type Section } from './production';

export function createWardrobe(api: ProdApi): Section {
  async function setPhoto(changeId: string, file: File) {
    const img = await api.storeImage(file, 1200);
    if (!img) return;
    api.update((p) => {
      const w = p.wardrobe.find((x) => x.id === changeId);
      if (w) w.img = img;
    });
  }

  return {
    render() {
      const p = api.prod();
      const scenes = api.scenes();
      const cast = api.cast().filter((c) => scenes.some((s) => s.cast.includes(c.character.toUpperCase())) || p.wardrobe.some((w) => w.character.toUpperCase() === c.character.toUpperCase()));
      if (!cast.length) return `<p class="pr-empty">${esc(tk('pr.noCast'))}</p>`;
      return `<p class="pr-intro">${esc(tk('pr.wardrobeHint'))}</p>
        ${cast
          .map((c) => {
            const name = c.character.toUpperCase();
            const own = scenes.filter((s) => s.cast.includes(name));
            const changes = p.wardrobe.filter((w) => w.character.toUpperCase() === name);
            const covered = new Set(changes.flatMap((w) => w.scenes));
            const missing = own.filter((s) => !covered.has(s.sid));
            return `<section class="pr-section pr-wd" data-character="${esc(name)}">
              <div class="pr-section-head">
                <h3>${esc(c.character)}${c.actor ? ` <small class="pr-muted">· ${esc(c.actor)}</small>` : ''}</h3>
                <p>${esc(tk(own.length === 1 ? 'pr.scene1' : 'pr.scenesN', { n: own.length }))}${changes.length && missing.length ? ` · ${esc(tk('pr.noCostume', { list: missing.map((s) => s.label).join(', ') }))}` : ''}</p>
                ${button('add-change', tk('pr.addChange'), ICON.plus)}
              </div>
              ${changes.length ? `<div class="pr-cards">${changes
                .map((w) => {
                  const url = w.img ? api.cachedUrl(w.img) : undefined;
                  return `<article class="pr-card pr-wd-card" data-coll="wardrobe" data-id="${esc(w.id)}">
                    <button type="button" class="pr-photo" data-act="photo" aria-label="${esc(tk('pr.addPhoto'))}" title="${esc(tk('pr.addPhoto'))}">
                      ${w.img ? `<img data-img="${esc(w.img)}" alt=""${url ? ` src="${url}"` : ''} />` : `<span>${ICON.image}${esc(tk('pr.addPhoto'))}</span>`}
                    </button>
                    <header class="pr-card-head">
                      <input class="pr-card-title-input" data-f="label" value="${esc(w.label)}" aria-label="${esc(tk('pr.changeName'))}" placeholder="${esc(tk('pr.changeName'))}" />
                      ${iconButton('del-change', tk('pr.delete'), ICON.trash)}
                    </header>
                    ${field('description', tk('pr.description'), w.description, { area: true, wide: true, ph: tk('pr.costumePh') })}
                    <div class="pr-chips" role="group" aria-label="${esc(tk('pr.wornIn'))}">
                      <span class="pr-chips-label">${esc(tk('pr.wornIn'))}</span>
                      ${own.map((s) => `<button type="button" class="pr-chip" data-act="toggle-scene" data-sid="${esc(s.sid)}" aria-pressed="${w.scenes.includes(s.sid)}" title="${esc(s.heading)}">${esc(s.label)}</button>`).join('')}
                    </div>
                  </article>`;
                })
                .join('')}</div>` : ''}
            </section>`;
          })
          .join('')}`;
    },
    click(el, act) {
      const sec = el.closest<HTMLElement>('[data-character]');
      const card = el.closest<HTMLElement>('[data-coll="wardrobe"]');
      const id = card?.dataset.id ?? '';
      if (act === 'add-change' && sec) {
        const character = sec.dataset.character!;
        const nid = newId();
        api.update((p) => {
          const n = p.wardrobe.filter((w) => w.character.toUpperCase() === character).length + 1;
          p.wardrobe.push({ id: nid, character, label: tk('pr.changeN', { n }), scenes: [] });
        });
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`[data-coll="wardrobe"][data-id="${nid}"] [data-f="label"]`)?.select());
      } else if (act === 'del-change') {
        if (!confirm(tk('pr.confirmDelete'))) return;
        api.update((p) => (p.wardrobe = p.wardrobe.filter((w) => w.id !== id)));
      } else if (act === 'toggle-scene') {
        const sid = el.dataset.sid!;
        const on = el.getAttribute('aria-pressed') !== 'true';
        el.setAttribute('aria-pressed', String(on));
        api.update((p) => {
          const w = p.wardrobe.find((x) => x.id === id);
          if (!w) return;
          w.scenes = on ? [...new Set([...w.scenes, sid])] : w.scenes.filter((x) => x !== sid);
          // A scene has one costume per character: take it off the other changes.
          if (on) for (const other of p.wardrobe) if (other !== w && other.character.toUpperCase() === w.character.toUpperCase()) other.scenes = other.scenes.filter((x) => x !== sid);
        });
      } else if (act === 'photo') {
        void api.pickImages().then(([f]) => f && setPhoto(id, f));
      }
    },
    dragover(e) {
      return Boolean((e.target as HTMLElement).closest('.pr-photo')) && [...(e.dataTransfer?.types ?? [])].includes('Files');
    },
    drop(e) {
      const card = (e.target as HTMLElement).closest<HTMLElement>('[data-coll="wardrobe"]');
      const f = [...(e.dataTransfer?.files ?? [])].find((x) => x.type.startsWith('image/'));
      if (!card || !f) return false;
      void setPhoto(card.dataset.id!, f);
      return true;
    },
  };
}
