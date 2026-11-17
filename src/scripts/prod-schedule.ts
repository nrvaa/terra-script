/**
 * Schedule: a stripboard. Every scene is a strip coloured like on a real board
 * (INT/EXT × day/night); strips are dragged into shooting days. On touch
 * screens each strip also has a day picker and up/down buttons.
 * "Cast by day" is the Day Out of Days table, computed from the schedule.
 */
import { newId } from './projects';
import { castDays, dayLocations, dayPages, doodCode, eighthsLabel, type SceneInfo } from './production-data';
import { ICON, button, esc, iconButton, tk, type ProdApi, type Section } from './production';
import type { ShootDay } from './types';

const VIEW_KEY = 'tewrite:schedView';

export function createSchedule(api: ProdApi): Section {
  let view: 'board' | 'dood' = 'board';
  try {
    if (localStorage.getItem(VIEW_KEY) === 'dood') view = 'dood';
  } catch {
    /* ignore */
  }
  let dragSid: string | null = null;

  const tone = (s: SceneInfo) => `${s.ie.startsWith('EXT') ? 'ext' : 'int'}-${s.night ? 'night' : 'day'}`;

  function strip(s: SceneInfo, days: ShootDay[], dayId: string | null, castNo: Map<string, number>) {
    const nums = s.cast
      .map((c) => castNo.get(c))
      .filter((x): x is number => x !== undefined)
      .sort((a, b) => a - b);
    return `<li class="pr-strip" draggable="true" data-sid="${esc(s.sid)}" data-tone="${tone(s)}">
      <span class="pr-grip" aria-hidden="true">${ICON.grip}</span>
      <span class="pr-strip-no">${esc(s.label)}</span>
      <span class="pr-strip-ie">${esc(s.ie || '—')}</span>
      <span class="pr-strip-main">
        <span class="pr-strip-loc">${esc(s.location || s.heading)}</span>
        ${s.synopsis ? `<span class="pr-strip-syn">${esc(s.synopsis)}</span>` : ''}
      </span>
      <span class="pr-strip-time">${esc(s.time || '')}</span>
      <span class="pr-strip-pages" title="${esc(tk('pr.pages'))}">${eighthsLabel(s.eighths)}</span>
      <span class="pr-strip-cast" title="${esc(tk('pr.cast'))}: ${esc(s.cast.join(', '))}">${esc(nums.join(', '))}</span>
      <span class="pr-strip-ctl">
        <select data-move aria-label="${esc(tk('pr.moveToDay'))}" title="${esc(tk('pr.moveToDay'))}">
          <option value=""${dayId ? '' : ' selected'}>${esc(tk('pr.unscheduled'))}</option>
          ${days.map((d, k) => `<option value="${esc(d.id)}"${d.id === dayId ? ' selected' : ''}>${esc(tk('pr.dayN', { n: k + 1 }))}${d.date ? ` · ${esc(api.dateLabel(d.date))}` : ''}</option>`).join('')}
        </select>
        ${iconButton('strip-up', tk('pr.earlier'), ICON.up)}
        ${iconButton('strip-down', tk('pr.later'), ICON.down)}
      </span>
    </li>`;
  }

  function renderBoard() {
    const p = api.prod();
    const scenes = api.scenes();
    const bySid = api.bySid();
    const castNo = new Map(api.cast().map((c, k) => [c.character.toUpperCase(), k + 1]));
    const scheduled = new Set(p.days.flatMap((d) => d.scenes));
    const pool = scenes.filter((s) => !scheduled.has(s.sid));
    const totalPages = scenes.reduce((n, s) => n + s.eighths, 0);
    const dayHtml = p.days
      .map((d, k) => {
        const strips = d.scenes.map((sid) => bySid.get(sid)).filter((s): s is SceneInfo => Boolean(s));
        const locs = dayLocations(d, bySid);
        return `<section class="pr-day" data-coll="days" data-id="${esc(d.id)}">
          <header class="pr-day-head">
            <h4>${esc(tk('pr.dayN', { n: k + 1 }))}</h4>
            <label class="pr-inline"><span>${esc(tk('pr.date'))}</span><input type="date" data-f="date" value="${esc(d.date ?? '')}" /></label>
            <label class="pr-inline"><span>${esc(tk('pr.crewCall'))}</span><input type="time" data-f="call" value="${esc(d.call ?? '')}" /></label>
            <label class="pr-inline"><span>${esc(tk('pr.wrap'))}</span><input type="time" data-f="wrap" value="${esc(d.wrap ?? '')}" /></label>
            <span class="pr-day-sum">${esc(tk('pr.pagesN', { n: eighthsLabel(dayPages(d, bySid) || 0) }))}${locs.length ? ` · ${esc(locs.join(', '))}` : ''}</span>
            ${iconButton('day-up', tk('pr.earlier'), ICON.up)}${iconButton('day-down', tk('pr.later'), ICON.down)}${iconButton('del-day', tk('pr.deleteDay'), ICON.trash)}
          </header>
          <ol class="pr-strips" data-day="${esc(d.id)}">${strips.length ? strips.map((s) => strip(s, p.days, d.id, castNo)).join('') : `<li class="pr-drop-hint">${esc(tk('pr.dropHere'))}</li>`}</ol>
          <label class="pr-field is-wide pr-day-notes"><span>${esc(tk('pr.dayNotes'))}</span><textarea data-f="notes" rows="2" placeholder="${esc(tk('pr.dayNotesPh'))}">${esc(d.notes ?? '')}</textarea></label>
        </section>`;
      })
      .join('');
    return `
      <div class="pr-legend" aria-hidden="true">
        <span data-tone="int-day">${esc(tk('pr.intDay'))}</span><span data-tone="ext-day">${esc(tk('pr.extDay'))}</span>
        <span data-tone="int-night">${esc(tk('pr.intNight'))}</span><span data-tone="ext-night">${esc(tk('pr.extNight'))}</span>
      </div>
      <section class="pr-pool">
        <header class="pr-day-head"><h4>${esc(tk('pr.unscheduled'))}</h4><span class="pr-day-sum">${esc(tk(pool.length === 1 ? 'pr.scene1' : 'pr.scenesN', { n: pool.length }))}</span></header>
        <ol class="pr-strips" data-day="">${pool.length ? pool.map((s) => strip(s, p.days, null, castNo)).join('') : `<li class="pr-drop-hint">${esc(scenes.length ? tk('pr.allScheduled') : tk('pr.noScenes'))}</li>`}</ol>
      </section>
      ${dayHtml}
      <div class="pr-day-add">${button('add-day', tk('pr.addDay'), ICON.plus, 'btn')}</div>
      <p class="pr-foot">${esc(tk('pr.totalPages', { n: eighthsLabel(totalPages || 0), days: p.days.length }))}</p>`;
  }

  function renderDood() {
    const p = api.prod();
    const cast = api.cast();
    const work = castDays(p.days, api.scenes(), cast);
    if (!p.days.length) return `<p class="pr-empty">${esc(tk('pr.noDays'))}</p>`;
    return `<div class="pr-table-wrap"><table class="pr-table pr-dood">
      <thead><tr><th>#</th><th>${esc(tk('pr.character'))}</th><th>${esc(tk('pr.actor'))}</th>
        ${p.days.map((d, k) => `<th class="pr-dood-day">${esc(tk('pr.dayShort', { n: k + 1 }))}${d.date ? `<small>${esc(api.dateLabel(d.date))}</small>` : ''}</th>`).join('')}
        <th>${esc(tk('pr.workDays'))}</th></tr></thead>
      <tbody>${cast
        .map((c, i) => {
          const w = work.get(c.id) ?? [];
          return `<tr><td class="pr-num-cell">${i + 1}</td><td><b>${esc(c.character)}</b></td><td>${esc(c.actor ?? '')}</td>
            ${p.days.map((_, k) => {
              const code = doodCode(w, k);
              return `<td class="pr-dood-cell" data-code="${code}">${code}</td>`;
            }).join('')}
            <td class="pr-num-cell"><b>${w.length}</b></td></tr>`;
        })
        .join('')}</tbody></table></div>
      <p class="pr-foot">${esc(tk('pr.doodLegend'))}</p>`;
  }

  /* ---------------- moving scenes ---------------- */

  function moveScene(sid: string, toDay: string | null, beforeSid: string | null) {
    api.update((p) => {
      for (const d of p.days) d.scenes = d.scenes.filter((x) => x !== sid);
      if (!toDay) return;
      const day = p.days.find((d) => d.id === toDay);
      if (!day) return;
      const at = beforeSid ? day.scenes.indexOf(beforeSid) : -1;
      day.scenes.splice(at < 0 ? day.scenes.length : at, 0, sid);
    });
  }

  function stepScene(sid: string, dir: -1 | 1) {
    const p = api.prod();
    const day = p.days.find((d) => d.scenes.includes(sid));
    if (!day) return;
    const k = day.scenes.indexOf(sid);
    const j = k + dir;
    if (j < 0 || j >= day.scenes.length) {
      // Past the end of a day: into the next / previous day.
      const di = p.days.indexOf(day) + dir;
      const other = p.days[di];
      if (!other) return;
      moveScene(sid, other.id, dir < 0 ? null : (other.scenes[0] ?? null));
    } else
      api.update((q) => {
        const d = q.days.find((x) => x.id === day.id)!;
        [d.scenes[k], d.scenes[j]] = [d.scenes[j], d.scenes[k]];
      });
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.pr-strip[data-sid="${CSS.escape(sid)}"] [data-act="strip-${dir < 0 ? 'up' : 'down'}"]`)?.focus());
  }

  /** Put unscheduled scenes into days: grouped by location, then day/night, about `pages` pages a day. */
  function autoSchedule() {
    const answer = prompt(tk('pr.autoPrompt'), '5');
    if (answer === null) return;
    const perDay = Math.max(1, Number(answer.replace(',', '.')) || 5) * 8;
    const p = api.prod();
    const scheduled = new Set(p.days.flatMap((d) => d.scenes));
    const pool = api.scenes().filter((s) => !scheduled.has(s.sid));
    if (!pool.length) return api.ctx.toast(tk('pr.allScheduled'));
    const firstAt = new Map<string, number>();
    pool.forEach((s, i) => firstAt.has(s.location) || firstAt.set(s.location, i));
    const order = [...pool].sort((a, b) => (firstAt.get(a.location)! - firstAt.get(b.location)!) || Number(a.night) - Number(b.night) || a.index - b.index);
    const lastDate = [...p.days].reverse().find((d) => d.date)?.date;
    let date = lastDate ? new Date(`${lastDate}T12:00:00`) : null;
    const newDays: ShootDay[] = [];
    let cur: ShootDay | null = null;
    let pages = 0;
    for (const s of order) {
      if (!cur || pages + s.eighths > perDay) {
        if (date) date = new Date(date.getTime() + 864e5);
        cur = { id: newId(), scenes: [], call: '07:00', ...(date ? { date: date.toISOString().slice(0, 10) } : {}) };
        newDays.push(cur);
        pages = 0;
      }
      cur.scenes.push(s.sid);
      pages += s.eighths;
    }
    api.update((q) => q.days.push(...newDays));
    api.ctx.toast(tk('pr.autoDone', { n: newDays.length }));
  }

  /* ---------------- drag & drop ---------------- */

  const placeOf = (e: DragEvent) => {
    const el = e.target as HTMLElement;
    const list = el.closest<HTMLElement>('.pr-strips');
    if (!list) return null;
    const stripEl = el.closest<HTMLElement>('.pr-strip');
    let before: string | null = null;
    if (stripEl) {
      const r = stripEl.getBoundingClientRect();
      const next = e.clientY < r.top + r.height / 2 ? stripEl : (stripEl.nextElementSibling as HTMLElement | null);
      before = next?.classList.contains('pr-strip') ? next.dataset.sid! : null;
    }
    return { list, day: list.dataset.day || null, before, stripEl };
  };

  return {
    render() {
      return `
        <div class="pr-toolbar">
          <div class="pr-seg" role="group" aria-label="${esc(tk('pr.tab.schedule'))}">
            <button type="button" data-act="view-board" aria-pressed="${view === 'board'}">${esc(tk('pr.stripboard'))}</button>
            <button type="button" data-act="view-dood" aria-pressed="${view === 'dood'}">${esc(tk('pr.dood'))}</button>
          </div>
          ${view === 'board' ? `${button('auto', tk('pr.auto'), ICON.wand)}${button('add-day', tk('pr.addDay'), ICON.plus)}` : ''}
        </div>
        ${view === 'board' ? renderBoard() : renderDood()}`;
    },
    click(el, act) {
      if (act === 'view-board' || act === 'view-dood') {
        view = act === 'view-dood' ? 'dood' : 'board';
        try {
          localStorage.setItem(VIEW_KEY, view);
        } catch {
          /* ignore */
        }
        return api.rerender();
      }
      if (act === 'auto') return autoSchedule();
      if (act === 'add-day') {
        const p = api.prod();
        const last = [...p.days].reverse().find((d) => d.date)?.date;
        const date = last ? new Date(new Date(`${last}T12:00:00`).getTime() + 864e5).toISOString().slice(0, 10) : undefined;
        const nid = newId();
        api.update((q) => q.days.push({ id: nid, scenes: [], call: '07:00', ...(date ? { date } : {}) }));
        requestAnimationFrame(() => document.querySelector<HTMLElement>(`.pr-day[data-id="${nid}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
        return;
      }
      const dayId = el.closest<HTMLElement>('.pr-day')?.dataset.id;
      const sid = el.closest<HTMLElement>('.pr-strip')?.dataset.sid;
      if (act === 'strip-up' && sid) return stepScene(sid, -1);
      if (act === 'strip-down' && sid) return stepScene(sid, 1);
      if (!dayId) return;
      if (act === 'del-day') {
        const day = api.prod().days.find((d) => d.id === dayId);
        if (day?.scenes.length && !confirm(tk('pr.confirmDeleteDay'))) return;
        api.update((p) => (p.days = p.days.filter((d) => d.id !== dayId)));
      } else if (act === 'day-up' || act === 'day-down') {
        api.update((p) => {
          const k = p.days.findIndex((d) => d.id === dayId);
          const j = k + (act === 'day-up' ? -1 : 1);
          if (k < 0 || j < 0 || j >= p.days.length) return;
          [p.days[k], p.days[j]] = [p.days[j], p.days[k]];
        });
      }
    },
    change(el) {
      if (el.matches('select[data-move]')) {
        const sid = el.closest<HTMLElement>('.pr-strip')?.dataset.sid;
        if (sid) moveScene(sid, (el as HTMLSelectElement).value || null, null);
      }
    },
    dragend() {
      dragSid = null;
    },
    dragstart(e) {
      const s = (e.target as HTMLElement).closest<HTMLElement>('.pr-strip');
      if (!s) return false;
      dragSid = s.dataset.sid!;
      s.classList.add('dragging');
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('text/plain', dragSid);
      return true;
    },
    dragover(e, root) {
      if (!dragSid) return false;
      const place = placeOf(e);
      root.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-into'));
      if (!place) return false;
      if (place.stripEl) {
        const r = place.stripEl.getBoundingClientRect();
        place.stripEl.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
      } else place.list.classList.add('drop-into');
      e.dataTransfer!.dropEffect = 'move';
      return true;
    },
    drop(e, root) {
      const sid = dragSid;
      dragSid = null;
      root.querySelectorAll('.drop-before, .drop-after, .drop-into, .dragging').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-into', 'dragging'));
      const place = placeOf(e);
      if (!sid || !place || place.before === sid) return Boolean(sid);
      moveScene(sid, place.day, place.before);
      return true;
    },
  };
}
