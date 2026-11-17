/**
 * Call sheet for one shooting day, filled from the schedule and the database:
 * crew call and wrap, locations with address and map, the day's scenes, the
 * cast in them (with their own call time and costume), the crew and notes.
 * Exported as a PDF that is easy to send around.
 */
import { PdfDoc } from './pdf-doc';
import { dayLocations, dayPages, eighthsLabel, type SceneInfo } from './production-data';
import { ICON, button, esc, tk, type ProdApi, type Section } from './production';
import { CREW_DEPTS, type CastRec, type ShootDay } from './types';

export function createCallSheet(api: ProdApi): Section {
  let dayId: string | null = null;

  const current = (): { day: ShootDay; k: number } | null => {
    const days = api.prod().days;
    if (!days.length) return null;
    let k = days.findIndex((d) => d.id === dayId);
    if (k < 0) {
      // Default: the next day that is today or later, else the first.
      const today = new Date().toISOString().slice(0, 10);
      k = Math.max(0, days.findIndex((d) => (d.date ?? '') >= today));
    }
    dayId = days[k].id;
    return { day: days[k], k };
  };

  /** Everything the sheet shows for a day. */
  function sheet(day: ShootDay) {
    const bySid = api.bySid();
    const scenes = day.scenes.map((sid) => bySid.get(sid)).filter((s): s is SceneInfo => Boolean(s));
    const allCast = api.cast();
    const castNo = new Map(allCast.map((c, k) => [c.character.toUpperCase(), k + 1]));
    const names = new Set(scenes.flatMap((s) => s.cast));
    const cast = allCast.filter((c) => names.has(c.character.toUpperCase()));
    const locs = api.locations();
    const locations = dayLocations(day, bySid).map((name) => locs.find((l) => l.name.toUpperCase() === name) ?? { id: `loc:${name}`, name });
    const wardrobe = (c: CastRec) =>
      api
        .prod()
        .wardrobe.filter((w) => w.character.toUpperCase() === c.character.toUpperCase() && w.scenes.some((sid) => day.scenes.includes(sid)))
        .map((w) => w.label)
        .join(', ');
    const crew = [...api.prod().crew].sort((a, b) => CREW_DEPTS.indexOf(a.dept) - CREW_DEPTS.indexOf(b.dept));
    return { scenes, cast, castNo, locations, wardrobe, crew, pages: eighthsLabel(dayPages(day, bySid) || 0) };
  }

  async function exportPdf() {
    const cur = current();
    if (!cur) return;
    const { day, k } = cur;
    const days = api.prod().days.length;
    const s = sheet(day);
    const title = api.ctx.title() || tk('file.default');
    const doc = new PdfDoc(api.ctx.paper(), `${title} - ${tk('pr.callSheet')} ${k + 1}`, (n, total) => tk('sb.pageOf', { n, total }));

    // Header
    doc.text(title, { size: 18, bold: true });
    doc.text(`${tk('pr.callSheet').toUpperCase()}  ·  ${tk('pr.dayOf', { n: k + 1, total: days })}${day.date ? `  ·  ${api.dateLabel(day.date, true)}` : ''}`, { size: 10.5, grey: 0.3 });
    doc.gap(10);
    const box = [
      [tk('pr.crewCall'), day.call || '—'],
      [tk('pr.wrap'), day.wrap || '—'],
      [tk('pr.pages'), s.pages],
      [tk('pr.scenesWord'), String(s.scenes.length)],
    ];
    const colW = doc.inner / box.length;
    const top = doc.y;
    doc.rect(doc.margin, top - 40, doc.inner, 40, 0.95);
    box.forEach(([label, value], i) => {
      doc.textAt(label.toUpperCase(), doc.margin + 10 + i * colW, top - 15, 7.5, true, 0.4);
      doc.textAt(value, doc.margin + 10 + i * colW, top - 32, 14, true);
    });
    doc.gap(48);

    if (s.locations.length) {
      doc.heading(tk('pr.locations'));
      doc.table(
        [130, 0, 120],
        [tk('pr.location'), tk('pr.address'), tk('pr.contactPerson')],
        s.locations.map((l) => [
          { text: l.name, bold: true },
          { text: [l.address, l.map].filter(Boolean).join('\n') || '—' },
          { text: [l.contact, l.phone].filter(Boolean).join('\n') || '—' },
        ]),
      );
    }

    doc.heading(tk('pr.scenesWord'));
    doc.table(
      [36, 0, 52, 46, 70],
      [tk('pr.sceneNo'), tk('pr.setDescription'), tk('pr.dn'), tk('pr.pages'), tk('pr.cast')],
      s.scenes.map((sc) => [
        { text: sc.label, bold: true },
        { text: `${sc.ie} ${sc.location}${sc.synopsis ? `\n${sc.synopsis}` : ''}` },
        { text: sc.time || '—' },
        { text: eighthsLabel(sc.eighths) },
        { text: sc.cast.map((c) => s.castNo.get(c)).filter(Boolean).sort((a, b) => a! - b!).join(', ') },
      ]),
    );

    doc.heading(tk('pr.cast'));
    doc.table(
      [28, 110, 110, 90, 50, 0],
      ['#', tk('pr.character'), tk('pr.actor'), tk('pr.phone'), tk('pr.call'), tk('pr.wardrobe')],
      s.cast.map((c) => [
        { text: String(s.castNo.get(c.character.toUpperCase()) ?? '') },
        { text: c.character, bold: true },
        { text: c.actor || '—' },
        { text: c.phone || '' },
        { text: day.castCalls?.[c.character.toUpperCase()] || day.call || '' },
        { text: s.wardrobe(c) },
      ]),
    );

    if (s.crew.length) {
      doc.heading(tk('pr.crew'));
      doc.table(
        [130, 0, 110, 50],
        [tk('pr.role'), tk('pr.crewName'), tk('pr.phone'), tk('pr.call')],
        s.crew.map((c) => [{ text: c.role || tk(`pr.dept.${c.dept}`), grey: !c.role }, { text: c.name || '—', bold: true }, { text: c.phone || '' }, { text: day.call || '' }]),
      );
    }
    if (day.notes?.trim()) {
      doc.heading(tk('pr.dayNotes'));
      doc.text(day.notes.trim(), { size: 9.5 });
    }
    const file = `${title} - ${tk('pr.callSheet')} ${tk('pr.dayShort', { n: k + 1 })}.pdf`;
    if (await api.ctx.save(file, doc.build(), 'application/pdf')) api.ctx.toast(tk('ex.done', { file }));
  }

  return {
    render() {
      const days = api.prod().days;
      const cur = current();
      if (!cur) return `<p class="pr-empty">${esc(tk('pr.noDaysCall'))}</p>`;
      const { day, k } = cur;
      const s = sheet(day);
      const mapLink = (m?: string) => (m && /^https?:\/\//i.test(m) ? `<a href="${esc(m)}" target="_blank" rel="noopener">${esc(tk('pr.openMap'))}</a>` : esc(m ?? ''));
      return `
        <div class="pr-toolbar">
          <label class="pr-inline"><span>${esc(tk('pr.shootDay'))}</span>
            <select data-pick-day>${days.map((d, i) => `<option value="${esc(d.id)}"${d.id === day.id ? ' selected' : ''}>${esc(tk('pr.dayN', { n: i + 1 }))}${d.date ? ` · ${esc(api.dateLabel(d.date))}` : ''}</option>`).join('')}</select>
          </label>
          ${button('export-call', tk('pr.exportPdf'), ICON.download, 'btn btn-sm btn-primary')}
        </div>
        <article class="pr-sheet" data-coll="days" data-id="${esc(day.id)}">
          <header class="pr-sheet-head">
            <div><h3>${esc(api.ctx.title() || tk('file.default'))}</h3>
              <p>${esc(tk('pr.callSheet'))} · ${esc(tk('pr.dayOf', { n: k + 1, total: days.length }))}</p></div>
            <div class="pr-sheet-date">${day.date ? esc(api.dateLabel(day.date, true)) : `<span class="pr-muted">${esc(tk('pr.noDate'))}</span>`}</div>
          </header>
          <div class="pr-sheet-key">
            <label><span>${esc(tk('pr.crewCall'))}</span><input type="time" data-f="call" value="${esc(day.call ?? '')}" /></label>
            <label><span>${esc(tk('pr.wrap'))}</span><input type="time" data-f="wrap" value="${esc(day.wrap ?? '')}" /></label>
            <div><span>${esc(tk('pr.pages'))}</span><b>${esc(s.pages)}</b></div>
            <div><span>${esc(tk('pr.scenesWord'))}</span><b>${s.scenes.length}</b></div>
          </div>

          <h4>${esc(tk('pr.locations'))}</h4>
          ${s.locations.length ? `<div class="pr-table-wrap"><table class="pr-table"><thead><tr><th>${esc(tk('pr.location'))}</th><th>${esc(tk('pr.address'))}</th><th>${esc(tk('pr.contactPerson'))}</th></tr></thead><tbody>
            ${s.locations.map((l) => `<tr><td><b>${esc(l.name)}</b></td><td>${esc(l.address ?? '') || '<span class="pr-muted">—</span>'}${l.map ? `<br>${mapLink(l.map)}` : ''}</td><td>${esc([l.contact, l.phone].filter(Boolean).join(' · ')) || '<span class="pr-muted">—</span>'}</td></tr>`).join('')}
          </tbody></table></div>${s.locations.some((l) => !l.address) ? `<p class="pr-hint">${esc(tk('pr.fillLocations'))}</p>` : ''}` : `<p class="pr-muted">${esc(tk('pr.noScenesDay'))}</p>`}

          <h4>${esc(tk('pr.scenesWord'))}</h4>
          ${s.scenes.length ? `<div class="pr-table-wrap"><table class="pr-table"><thead><tr><th>${esc(tk('pr.sceneNo'))}</th><th>${esc(tk('pr.setDescription'))}</th><th>${esc(tk('pr.dn'))}</th><th>${esc(tk('pr.pages'))}</th><th>${esc(tk('pr.cast'))}</th></tr></thead><tbody>
            ${s.scenes.map((sc) => `<tr><td><b>${esc(sc.label)}</b></td><td>${esc(`${sc.ie} ${sc.location}`)}${sc.synopsis ? `<br><small class="pr-muted">${esc(sc.synopsis)}</small>` : ''}</td><td>${esc(sc.time)}</td><td>${eighthsLabel(sc.eighths)}</td><td>${esc(sc.cast.map((c) => s.castNo.get(c)).filter(Boolean).sort((a, b) => a! - b!).join(', '))}</td></tr>`).join('')}
          </tbody></table></div>` : `<p class="pr-muted">${esc(tk('pr.noScenesDay'))}</p>`}

          <h4>${esc(tk('pr.cast'))}</h4>
          ${s.cast.length ? `<div class="pr-table-wrap"><table class="pr-table"><thead><tr><th>#</th><th>${esc(tk('pr.character'))}</th><th>${esc(tk('pr.actor'))}</th><th>${esc(tk('pr.phone'))}</th><th>${esc(tk('pr.call'))}</th><th>${esc(tk('pr.wardrobe'))}</th></tr></thead><tbody>
            ${s.cast.map((c) => `<tr><td class="pr-num-cell">${s.castNo.get(c.character.toUpperCase()) ?? ''}</td><td><b>${esc(c.character)}</b></td><td>${esc(c.actor ?? '') || `<span class="pr-muted">${esc(tk('pr.noActor'))}</span>`}</td><td>${esc(c.phone ?? '')}</td>
              <td><input type="time" class="pr-cell-input" data-cast-call="${esc(c.character.toUpperCase())}" value="${esc(day.castCalls?.[c.character.toUpperCase()] ?? day.call ?? '')}" aria-label="${esc(tk('pr.callFor', { name: c.character }))}" /></td><td>${esc(s.wardrobe(c))}</td></tr>`).join('')}
          </tbody></table></div>` : `<p class="pr-muted">${esc(tk('pr.noCastDay'))}</p>`}

          <h4>${esc(tk('pr.crew'))}</h4>
          ${s.crew.length ? `<div class="pr-table-wrap"><table class="pr-table"><thead><tr><th>${esc(tk('pr.role'))}</th><th>${esc(tk('pr.crewName'))}</th><th>${esc(tk('pr.phone'))}</th></tr></thead><tbody>
            ${s.crew.map((c) => `<tr><td>${esc(c.role || tk(`pr.dept.${c.dept}`))}</td><td><b>${esc(c.name)}</b></td><td>${esc(c.phone ?? '')}</td></tr>`).join('')}
          </tbody></table></div>` : `<p class="pr-muted">${esc(tk('pr.noCrew'))}</p>`}

          <label class="pr-field is-wide"><span>${esc(tk('pr.dayNotes'))}</span><textarea data-f="notes" rows="3" placeholder="${esc(tk('pr.dayNotesPh'))}">${esc(day.notes ?? '')}</textarea></label>
        </article>`;
    },
    click(_el, act) {
      if (act === 'export-call') void exportPdf();
    },
    change(el) {
      if (el.matches('[data-pick-day]')) {
        dayId = (el as HTMLSelectElement).value;
        api.rerender();
      } else if (el.matches('[data-cast-call]')) {
        const castId = (el as HTMLInputElement).dataset.castCall!;
        const value = (el as HTMLInputElement).value;
        const id = dayId;
        api.update((p) => {
          const d = p.days.find((x) => x.id === id);
          if (!d) return;
          d.castCalls = { ...(d.castCalls ?? {}), [castId]: value };
          if (!value || value === d.call) delete d.castCalls[castId];
        }, false);
      }
    },
  };
}
