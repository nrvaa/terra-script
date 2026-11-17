/**
 * Database: locations and cast come from the script (scene headings, speaking
 * characters, cast tags) and get details here; crew is added by hand.
 */
import { newId } from './projects';
import { isDerived } from './production-data';
import { ICON, button, esc, field, iconButton, tk, type ProdApi, type Section } from './production';
import { CREW_DEPTS, type CrewDept } from './types';

export function createDatabase(api: ProdApi): Section {
  /** Scene numbers a location / character appears in. */
  const sceneList = (match: (s: ReturnType<ProdApi['scenes']>[number]) => boolean) => {
    const list = api.scenes().filter(match);
    return list.length
      ? `<p class="pr-scenes" title="${esc(list.map((s) => s.heading).join('\n'))}">${esc(tk(list.length === 1 ? 'pr.scene1' : 'pr.scenesN', { n: list.length }))}: ${esc(list.map((s) => s.label).join(', '))}</p>`
      : `<p class="pr-scenes is-none">${esc(tk('pr.notInScript'))}</p>`;
  };

  const locationCard = (l: ReturnType<ProdApi['locations']>[number]) => {
    const fromScript = api.scenes().some((s) => s.location === l.name.toUpperCase());
    return `<article class="pr-card" data-coll="locations" data-id="${esc(l.id)}" data-key="${esc(l.name)}">
      <header class="pr-card-head">
        ${l.manual ? `<input class="pr-card-title-input" data-f="name" value="${esc(l.name)}" aria-label="${esc(tk('pr.locName'))}" placeholder="${esc(tk('pr.locName'))}" />` : `<h4 class="pr-card-title">${esc(l.name)}</h4>`}
        ${fromScript ? `<span class="pr-badge">${esc(tk('pr.fromScript'))}</span>` : ''}
        ${!fromScript || l.manual ? iconButton('del-location', tk('pr.delete'), ICON.trash) : ''}
      </header>
      ${sceneList((s) => s.location === l.name.toUpperCase())}
      <div class="pr-fields">
        ${field('address', tk('pr.address'), l.address, { wide: true, area: true })}
        ${field('contact', tk('pr.contactPerson'), l.contact)}
        ${field('phone', tk('pr.phone'), l.phone, { type: 'tel' })}
        ${field('map', tk('pr.map'), l.map, { ph: 'https://maps.google.com/…', wide: true })}
        ${field('rate', tk('pr.ratePerDay'), l.rate, { num: true })}
        ${field('notes', tk('pr.notes'), l.notes, { wide: true, area: true, ph: tk('pr.locNotesPh') })}
      </div>
    </article>`;
  };

  const castCard = (c: ReturnType<ProdApi['cast']>[number], k: number) => `<article class="pr-card" data-coll="cast" data-id="${esc(c.id)}" data-key="${esc(c.character)}">
      <header class="pr-card-head">
        <span class="pr-num" title="${esc(tk('pr.castNo'))}">${k + 1}</span>
        <h4 class="pr-card-title">${esc(c.character)}</h4>
        ${c.manual || !api.scenes().some((s) => s.cast.includes(c.character.toUpperCase())) ? iconButton('del-cast', tk('pr.delete'), ICON.trash) : ''}
      </header>
      ${sceneList((s) => s.cast.includes(c.character.toUpperCase()))}
      <div class="pr-fields">
        ${field('actor', tk('pr.actor'), c.actor, { wide: true, ph: tk('pr.actorPh') })}
        ${field('phone', tk('pr.phone'), c.phone, { type: 'tel' })}
        ${field('email', tk('pr.email'), c.email, { type: 'email' })}
        ${field('rate', tk('pr.feePerDay'), c.rate, { num: true })}
        ${field('notes', tk('pr.notes'), c.notes, { wide: true, area: true, ph: tk('pr.castNotesPh') })}
      </div>
    </article>`;

  const crewCard = (c: ReturnType<ProdApi['prod']>['crew'][number]) => `<article class="pr-card" data-coll="crew" data-id="${esc(c.id)}">
      <header class="pr-card-head">
        <input class="pr-card-title-input" data-f="name" value="${esc(c.name)}" placeholder="${esc(tk('pr.crewName'))}" aria-label="${esc(tk('pr.crewName'))}" />
        ${iconButton('del-crew', tk('pr.delete'), ICON.trash)}
      </header>
      <div class="pr-fields">
        ${field('role', tk('pr.role'), c.role, { ph: tk('pr.rolePh'), list: 'pr-roles' })}
        <label class="pr-field"><span>${esc(tk('pr.dept'))}</span><select data-f="dept" aria-label="${esc(tk('pr.dept'))}">
          ${CREW_DEPTS.map((d) => `<option value="${d}"${d === c.dept ? ' selected' : ''}>${esc(tk(`pr.dept.${d}`))}</option>`).join('')}
        </select></label>
        ${field('phone', tk('pr.phone'), c.phone, { type: 'tel' })}
        ${field('email', tk('pr.email'), c.email, { type: 'email' })}
        ${field('rate', tk('pr.feePerDay'), c.rate, { num: true })}
      </div>
    </article>`;

  const ROLES = ['Director', 'Assistant Director', 'Producer', 'Line Producer', 'Production Manager', 'Director of Photography', 'Camera Operator', 'Focus Puller', 'Gaffer', 'Grip', 'Sound Recordist', 'Boom Operator', 'Production Designer', 'Art Director', 'Props Master', 'Costume Designer', 'Makeup Artist', 'Script Supervisor', 'Editor', 'Runner', 'Driver', 'Catering'];

  return {
    render() {
      const locations = api.locations();
      const cast = api.cast();
      const crew = [...api.prod().crew].sort((a, b) => CREW_DEPTS.indexOf(a.dept) - CREW_DEPTS.indexOf(b.dept));
      const empty = !api.scenes().length;
      return `
        ${empty ? `<p class="pr-empty">${esc(tk('pr.noScenes'))}</p>` : ''}
        <nav class="pr-jump" aria-label="${esc(tk('pr.tab.db'))}">
          <a href="#pr-locations">${esc(tk('pr.locations'))} <b>${locations.length}</b></a>
          <a href="#pr-cast">${esc(tk('pr.cast'))} <b>${cast.length}</b></a>
          <a href="#pr-crew">${esc(tk('pr.crew'))} <b>${crew.length}</b></a>
        </nav>
        <section class="pr-section" id="pr-locations">
          <div class="pr-section-head"><h3>${esc(tk('pr.locations'))}</h3><p>${esc(tk('pr.locationsHint'))}</p>${button('add-location', tk('pr.addLocation'), ICON.plus)}</div>
          <div class="pr-cards">${locations.map(locationCard).join('')}</div>
        </section>
        <section class="pr-section" id="pr-cast">
          <div class="pr-section-head"><h3>${esc(tk('pr.cast'))}</h3><p>${esc(tk('pr.castHint'))}</p>${button('add-cast', tk('pr.addCast'), ICON.plus)}</div>
          <div class="pr-cards">${cast.map(castCard).join('')}</div>
        </section>
        <section class="pr-section" id="pr-crew">
          <div class="pr-section-head"><h3>${esc(tk('pr.crew'))}</h3><p>${esc(tk('pr.crewHint'))}</p>${button('add-crew', tk('pr.addCrew'), ICON.plus)}</div>
          ${crew.length ? `<div class="pr-cards">${crew.map(crewCard).join('')}</div>` : `<p class="pr-empty">${esc(tk('pr.noCrew'))}</p>`}
        </section>
        <datalist id="pr-roles">${ROLES.map((r) => `<option value="${esc(r)}"></option>`).join('')}</datalist>`;
    },
    click(el, act) {
      const row = el.closest<HTMLElement>('[data-coll][data-id]');
      const id = row?.dataset.id ?? '';
      const focusNew = (coll: string, newIdValue: string) =>
        requestAnimationFrame(() => {
          const card = document.querySelector<HTMLElement>(`[data-coll="${coll}"][data-id="${newIdValue}"]`);
          card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          card?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true });
        });
      if (act === 'add-location') {
        const nid = newId();
        api.update((p) => p.locations.push({ id: nid, name: '', manual: true }));
        focusNew('locations', nid);
      } else if (act === 'add-cast') {
        const name = prompt(tk('pr.newCharacter'))?.trim().toUpperCase();
        if (!name) return;
        const nid = newId();
        api.update((p) => p.cast.push({ id: nid, character: name, manual: true }));
        focusNew('cast', nid);
      } else if (act === 'add-crew') {
        const nid = newId();
        api.update((p) => p.crew.push({ id: nid, name: '', role: '', dept: 'other' as CrewDept }));
        focusNew('crew', nid);
      } else if (act === 'del-location' || act === 'del-cast' || act === 'del-crew') {
        if (isDerived(id)) return;
        if (!confirm(tk('pr.confirmDelete'))) return;
        const coll = act === 'del-location' ? 'locations' : act === 'del-cast' ? 'cast' : 'crew';
        api.update((p) => {
          const list = p[coll] as { id: string }[];
          const k = list.findIndex((r) => r.id === id);
          if (k >= 0) list.splice(k, 1);
        });
      }
    },
  };
}
