/**
 * Budget: line items per category. Lines can be linked to a cast member, a crew
 * member or a location; their quantity then follows the schedule (days worked,
 * shooting days, days at that location). Contingency is added on top.
 */
import { newId } from './projects';
import { castDays, isDerived, lineQty, locationDayCounts } from './production-data';
import { ICON, button, esc, iconButton, tk, type ProdApi, type Section } from './production';
import { BUDGET_CATS, type BudgetCat, type BudgetLine, type Production } from './types';

const CURRENCIES = ['IDR', 'USD', 'EUR', 'SGD', 'MYR', 'AUD', 'GBP', 'JPY', 'PHP', 'THB'];

export function createBudget(api: ProdApi): Section {
  function context(p: Production) {
    const scenes = api.scenes();
    const castWork = castDays(p.days, scenes, api.cast());
    const locationDays = locationDayCounts(p.days, api.bySid(), api.locations());
    return { days: p.days, castWork, locationDays };
  }

  function totals(p: Production) {
    const ctx = context(p);
    const line = (l: BudgetLine) => lineQty(l, ctx) * (l.rate || 0);
    const byCat = new Map<BudgetCat, number>();
    for (const l of p.budget) byCat.set(l.cat, (byCat.get(l.cat) ?? 0) + line(l));
    const subtotal = [...byCat.values()].reduce((a, b) => a + b, 0);
    const contingency = (subtotal * (p.contingency ?? 0)) / 100;
    return { ctx, line, byCat, subtotal, contingency, total: subtotal + contingency };
  }

  const linkName = (l: BudgetLine) => {
    if (!l.link) return '';
    if (l.link.kind === 'cast') return tk('pr.linkCast');
    if (l.link.kind === 'crew') return tk('pr.linkCrew');
    return tk('pr.linkLocation');
  };

  function row(l: BudgetLine, t: ReturnType<typeof totals>) {
    const qty = lineQty(l, t.ctx);
    return `<tr data-coll="budget" data-id="${esc(l.id)}">
      <td><input data-f="item" value="${esc(l.item)}" placeholder="${esc(tk('pr.item'))}" aria-label="${esc(tk('pr.item'))}" /></td>
      <td class="pr-num-cell">${l.link ? `<span class="pr-linked" title="${esc(linkName(l))}">${qty}</span>` : `<input data-f="qty" data-num type="number" min="0" step="any" inputmode="decimal" value="${l.qty}" aria-label="${esc(tk('pr.qty'))}" />`}</td>
      <td><input data-f="unit" value="${esc(l.unit ?? '')}" placeholder="${esc(tk('pr.unitPh'))}" aria-label="${esc(tk('pr.unit'))}" list="pr-units" /></td>
      <td class="pr-num-cell"><input data-f="rate" data-num type="number" min="0" step="any" inputmode="decimal" value="${l.rate || ''}" placeholder="0" aria-label="${esc(tk('pr.rate'))}" /></td>
      <td class="pr-num-cell pr-line-total">${esc(api.money(qty * (l.rate || 0)))}</td>
      <td>${iconButton('del-line', tk('pr.delete'), ICON.trash)}</td>
    </tr>`;
  }

  /** Lines for every cast member, crew member and location that doesn't have one yet. */
  function fill() {
    const cast = api.cast();
    const locations = api.locations();
    let added = 0;
    api.update((p) => {
      const linked = new Set(p.budget.filter((l) => l.link).map((l) => `${l.link!.kind}:${l.link!.id}`));
      const materialize = <T extends { id: string }>(list: T[], rec: T): string => {
        if (!isDerived(rec.id)) return rec.id;
        const fresh = { ...rec, id: newId() };
        list.push(fresh);
        return fresh.id;
      };
      for (const c of cast) {
        const existing = p.cast.find((x) => x.character.toUpperCase() === c.character.toUpperCase());
        const id = existing?.id ?? materialize(p.cast, { ...c });
        if (linked.has(`cast:${id}`)) continue;
        p.budget.push({ id: newId(), cat: 'cast', item: c.actor ? `${c.actor} (${c.character})` : c.character, qty: 0, unit: tk('pr.unitDay'), rate: c.rate ?? 0, link: { kind: 'cast', id } });
        added++;
      }
      for (const c of p.crew) {
        if (linked.has(`crew:${c.id}`)) continue;
        p.budget.push({ id: newId(), cat: 'crew', item: [c.role, c.name].filter(Boolean).join(' – ') || tk(`pr.dept.${c.dept}`), qty: 0, unit: tk('pr.unitDay'), rate: c.rate ?? 0, link: { kind: 'crew', id: c.id } });
        added++;
      }
      for (const l of locations) {
        const existing = p.locations.find((x) => x.name.toUpperCase() === l.name.toUpperCase());
        const id = existing?.id ?? materialize(p.locations, { ...l });
        if (linked.has(`location:${id}`)) continue;
        p.budget.push({ id: newId(), cat: 'locations', item: l.name, qty: 0, unit: tk('pr.unitDay'), rate: l.rate ?? 0, link: { kind: 'location', id } });
        added++;
      }
    });
    api.ctx.toast(tk(added ? 'pr.filled' : 'pr.nothingToFill', { n: added }));
  }

  async function exportCsv() {
    const p = api.prod();
    const t = totals(p);
    const cell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [[tk('pr.category'), tk('pr.item'), tk('pr.qty'), tk('pr.unit'), tk('pr.rate'), tk('pr.total')]];
    for (const cat of BUDGET_CATS) for (const l of p.budget.filter((x) => x.cat === cat)) rows.push([tk(`pr.cat.${cat}`), l.item, lineQty(l, t.ctx), l.unit ?? '', l.rate || 0, t.line(l)] as string[]);
    rows.push([], ['', tk('pr.subtotal'), '', '', '', t.subtotal] as string[], ['', `${tk('pr.contingency')} ${p.contingency ?? 0}%`, '', '', '', t.contingency] as string[], ['', tk('pr.total'), '', '', '', t.total] as string[]);
    const csv = '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
    const file = `${api.ctx.title() || tk('file.default')} - ${tk('pr.tab.budget')}.csv`;
    if (await api.ctx.save(file, csv, 'text/csv')) api.ctx.toast(tk('ex.done', { file }));
  }

  return {
    render() {
      const p = api.prod();
      const t = totals(p);
      const currency = p.currency ?? 'IDR';
      return `
        <div class="pr-toolbar">
          <label class="pr-inline"><span>${esc(tk('pr.currency'))}</span><select data-currency>${CURRENCIES.map((c) => `<option${c === currency ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
          <label class="pr-inline"><span>${esc(tk('pr.contingency'))} %</span><input data-contingency type="number" min="0" max="100" step="1" value="${p.contingency ?? 0}" class="pr-small-input" /></label>
          ${button('fill', tk('pr.fill'), ICON.wand)}
          ${button('csv', tk('pr.exportCsv'), ICON.download)}
        </div>
        <div class="pr-totals">
          <div><span>${esc(tk('pr.subtotal'))}</span><b data-total="sub">${esc(api.money(t.subtotal))}</b></div>
          <div><span>${esc(tk('pr.contingency'))} (${p.contingency ?? 0}%)</span><b data-total="cont">${esc(api.money(t.contingency))}</b></div>
          <div class="is-grand"><span>${esc(tk('pr.total'))}</span><b data-total="all">${esc(api.money(t.total))}</b></div>
        </div>
        <p class="pr-hint">${esc(tk('pr.budgetHint'))}</p>
        ${BUDGET_CATS.map((cat) => {
          const lines = p.budget.filter((l) => l.cat === cat);
          return `<details class="pr-cat" data-cat="${cat}"${lines.length ? ' open' : ''}>
            <summary><span>${esc(tk(`pr.cat.${cat}`))}</span><b data-cat-total="${cat}">${esc(api.money(t.byCat.get(cat) ?? 0))}</b></summary>
            ${lines.length ? `<div class="pr-table-wrap"><table class="pr-table pr-budget">
              <thead><tr><th>${esc(tk('pr.item'))}</th><th>${esc(tk('pr.qty'))}</th><th>${esc(tk('pr.unit'))}</th><th>${esc(tk('pr.rate'))}</th><th>${esc(tk('pr.total'))}</th><th></th></tr></thead>
              <tbody>${lines.map((l) => row(l, t)).join('')}</tbody></table></div>` : ''}
            ${button('add-line', tk('pr.addLine'), ICON.plus, 'btn btn-sm pr-add-line', `data-cat="${cat}"`)}
          </details>`;
        }).join('')}
        <datalist id="pr-units">${['unitDay', 'unitPerson', 'unitPackage', 'unitUnit', 'unitTrip', 'unitMeal'].map((u) => `<option value="${esc(tk(`pr.${u}`))}"></option>`).join('')}</datalist>`;
    },
    refresh(root) {
      const p = api.prod();
      const t = totals(p);
      for (const tr of root.querySelectorAll<HTMLElement>('tr[data-coll="budget"]')) {
        const l = p.budget.find((x) => x.id === tr.dataset.id);
        const cellEl = tr.querySelector('.pr-line-total');
        if (l && cellEl) cellEl.textContent = api.money(t.line(l));
      }
      for (const cat of BUDGET_CATS) {
        const el = root.querySelector(`[data-cat-total="${cat}"]`);
        if (el) el.textContent = api.money(t.byCat.get(cat) ?? 0);
      }
      root.querySelector('[data-total="sub"]')!.textContent = api.money(t.subtotal);
      root.querySelector('[data-total="cont"]')!.textContent = api.money(t.contingency);
      root.querySelector('[data-total="all"]')!.textContent = api.money(t.total);
    },
    click(el, act) {
      if (act === 'fill') return fill();
      if (act === 'csv') return void exportCsv();
      if (act === 'add-line') {
        const cat = el.dataset.cat as BudgetCat;
        const nid = newId();
        api.update((p) => p.budget.push({ id: nid, cat, item: '', qty: 1, rate: 0 }));
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`tr[data-id="${nid}"] [data-f="item"]`)?.focus());
        return;
      }
      if (act === 'del-line') {
        const id = el.closest<HTMLElement>('[data-id]')?.dataset.id;
        api.update((p) => (p.budget = p.budget.filter((l) => l.id !== id)));
      }
    },
    change(el) {
      if (el.matches('[data-currency]')) api.update((p) => (p.currency = (el as HTMLSelectElement).value));
      else if (el.matches('[data-contingency]')) {
        const v = Math.min(100, Math.max(0, Number((el as HTMLInputElement).value) || 0));
        api.update((p) => (p.contingency = v));
      }
    },
  };
}
