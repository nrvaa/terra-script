/**
 * Pre-production data that comes from the script itself: scenes with their
 * location, time of day, length (in eighths of a page) and cast; the list of
 * locations and characters; and what follows from the shooting schedule
 * (who works on which day, budget quantities).
 */
import { layoutPages, pageGeometry, type LayoutOptions } from './pdf';
import { breakdown } from './tagger';
import {
  BUDGET_CATS,
  CREW_DEPTS,
  SCENE_PREFIX,
  characterName,
  emptyProduction,
  type Block,
  type BudgetCat,
  type BudgetLine,
  type CastRec,
  type CrewRec,
  type CrewDept,
  type LocationRec,
  type MoodItem,
  type Production,
  type ShootDay,
  type Tag,
  type WardrobeChange,
} from './types';

export interface SceneInfo {
  sid: string;
  index: number;
  label: string;
  heading: string;
  /** INT, EXT or INT/EXT. */
  ie: string;
  /** Location name, e.g. "ALL-NIGHT DINER". */
  location: string;
  /** DAY, NIGHT, DAWN… (as written). */
  time: string;
  night: boolean;
  /** Length in eighths of a page (8 = one page). */
  eighths: number;
  /** Speaking characters plus characters tagged as cast. */
  cast: string[];
  synopsis?: string;
  /** Tagged breakdown items (props, wardrobe, vehicles…) by category. */
  items: Map<string, string[]>;
}

const NIGHT = /\b(NIGHT|MALAM|EVENING|SENJA|DUSK|MAGRIB)\b/;

/** "INT. ALL-NIGHT DINER - NIGHT" → INT / ALL-NIGHT DINER / NIGHT. */
export function parseHeading(text: string): { ie: string; location: string; time: string } {
  let t = text.trim().toUpperCase();
  const m = t.match(SCENE_PREFIX);
  let ie = '';
  if (m) {
    const p = m[1].replace(/\./g, '');
    ie = /\/|I\/E/.test(p) ? 'INT/EXT' : p === 'EST' ? 'EXT' : p;
    t = t.slice(m[0].length).replace(/^[.\s]+/, '');
  }
  const parts = t.split(/\s+[-–—]\s+/);
  const time = parts.length > 1 ? parts.pop()!.trim() : '';
  return { ie, location: parts.join(' - ').trim(), time };
}

/** Scenes of the script with what the schedule needs to know. */
export function sceneInfos(blocks: Block[], tags: Tag[], layout: LayoutOptions, labels: Map<number, string>): SceneInfo[] {
  // Length: count the printed lines of each scene in the real page layout.
  const owner: number[] = [];
  let cur = -1;
  blocks.forEach((b, i) => {
    if (b.type === 'scene') cur = i;
    owner[i] = cur;
  });
  const lines = new Map<number, number>();
  let linesPerPage = 55;
  try {
    const pages = layoutPages(blocks, layout);
    linesPerPage = pageGeometry(layout.paper).linesPerPage;
    let last = -1;
    for (const p of pages) {
      for (const row of p.rows) {
        const src = (row as { src?: number }).src;
        if (src !== undefined) last = owner[src] ?? -1;
        if (last >= 0) lines.set(last, (lines.get(last) ?? 0) + 1);
      }
    }
  } catch {
    /* layout failed: lengths stay unknown */
  }
  const items = new Map(breakdown(blocks, tags, layout).map((s) => [s.index, s.items]));
  const castTags = tags.filter((tg) => tg.cat === 'cast').map((tg) => tg.text.toUpperCase());

  const out: SceneInfo[] = [];
  blocks.forEach((b, i) => {
    if (b.type !== 'scene' || !b.sid) return;
    const { ie, location, time } = parseHeading(b.text);
    const cast = new Set<string>();
    for (let j = i + 1; j < blocks.length && blocks[j].type !== 'scene'; j++) {
      if (blocks[j].type === 'character') {
        const n = characterName(blocks[j].text);
        if (n) cast.add(n);
      }
    }
    const it = items.get(i) ?? new Map();
    for (const c of it.get('cast') ?? []) if (castTags.includes(c.toUpperCase())) cast.add(c.toUpperCase());
    out.push({
      sid: b.sid,
      index: i,
      label: labels.get(i) ?? String(out.length + 1),
      heading: b.text.trim().toUpperCase(),
      ie,
      location,
      time,
      night: NIGHT.test(time),
      eighths: Math.max(1, Math.round(((lines.get(i) ?? 1) / linesPerPage) * 8)),
      cast: [...cast],
      synopsis: b.synopsis,
      items: it,
    });
  });
  return out;
}

/** 11 eighths → "1 3/8". */
export function eighthsLabel(n: number): string {
  const pages = Math.floor(n / 8);
  const rest = n % 8;
  return pages && rest ? `${pages} ${rest}/8` : pages ? String(pages) : `${rest}/8`;
}

/** Locations of the script merged with what the user added. */
export function mergedLocations(scenes: SceneInfo[], prod: Production): LocationRec[] {
  const recs = [...prod.locations];
  const known = new Set(recs.map((r) => r.name.toUpperCase()));
  for (const s of scenes) {
    if (!s.location || known.has(s.location)) continue;
    known.add(s.location);
    recs.push({ id: `loc:${s.location}`, name: s.location });
  }
  return recs;
}

/** Characters of the script merged with the cast details the user added. */
export function mergedCast(scenes: SceneInfo[], prod: Production): CastRec[] {
  const recs = [...prod.cast];
  const known = new Set(recs.map((r) => r.character.toUpperCase()));
  // Order: by number of scenes, like a cast list (lead first).
  const count = new Map<string, number>();
  for (const s of scenes) for (const c of s.cast) count.set(c, (count.get(c) ?? 0) + 1);
  for (const c of [...count.keys()].sort((a, b) => count.get(b)! - count.get(a)!)) {
    if (known.has(c)) continue;
    known.add(c);
    recs.push({ id: `cast:${c}`, character: c });
  }
  return recs.sort((a, b) => (count.get(b.character.toUpperCase()) ?? 0) - (count.get(a.character.toUpperCase()) ?? 0));
}

/** Records derived from the script have ids like "cast:MAYA" until the user edits them. */
export const isDerived = (id: string) => id.startsWith('cast:') || id.startsWith('loc:');

/* ---------------- schedule ---------------- */

/** Day Out of Days: for each cast member, the days they work (indices into days). */
export function castDays(days: ShootDay[], scenes: SceneInfo[], cast: CastRec[]): Map<string, number[]> {
  const bySid = new Map(scenes.map((s) => [s.sid, s]));
  const out = new Map<string, number[]>();
  for (const c of cast) {
    const name = c.character.toUpperCase();
    out.set(
      c.id,
      days.flatMap((d, k) => (d.scenes.some((sid) => bySid.get(sid)?.cast.includes(name)) ? [k] : [])),
    );
  }
  return out;
}

/** Industry codes per day: SW start work, W work, WF work finish, SWF one day only, H hold. */
export function doodCode(work: number[], day: number): string {
  if (!work.length) return '';
  const first = work[0];
  const last = work[work.length - 1];
  if (!work.includes(day)) return day > first && day < last ? 'H' : '';
  if (first === last) return 'SWF';
  if (day === first) return 'SW';
  if (day === last) return 'WF';
  return 'W';
}

export const dayPages = (day: ShootDay, bySid: Map<string, SceneInfo>) => day.scenes.reduce((n, sid) => n + (bySid.get(sid)?.eighths ?? 0), 0);

/** Locations used on a day (from its scenes), in shooting order. */
export const dayLocations = (day: ShootDay, bySid: Map<string, SceneInfo>) => [...new Set(day.scenes.map((sid) => bySid.get(sid)?.location ?? '').filter(Boolean))];

/* ---------------- budget ---------------- */

/** Quantity of a budget line: linked lines follow the schedule (number of days). */
export function lineQty(line: BudgetLine, ctx: { days: ShootDay[]; castWork: Map<string, number[]>; locationDays: Map<string, number> }): number {
  if (!line.link) return line.qty;
  if (line.link.kind === 'cast') return ctx.castWork.get(line.link.id)?.length ?? 0;
  if (line.link.kind === 'crew') return ctx.days.length;
  return ctx.locationDays.get(line.link.id) ?? 0;
}

/** Number of shooting days at each location (by location record id). */
export function locationDayCounts(days: ShootDay[], bySid: Map<string, SceneInfo>, locations: LocationRec[]): Map<string, number> {
  const byName = new Map(locations.map((l) => [l.name.toUpperCase(), l.id]));
  const out = new Map<string, number>();
  for (const d of days) for (const name of dayLocations(d, bySid)) {
    const id = byName.get(name);
    if (id) out.set(id, (out.get(id) ?? 0) + 1);
  }
  return out;
}

/* ---------------- validation (.terra files are untrusted) ---------------- */

const s = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const ID = /^[\w:.\- ]{1,80}$/u;
const id = (v: unknown, fallback: () => string) => (typeof v === 'string' && ID.test(v) ? v : fallback());
const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]).filter((x) => x && typeof x === 'object').slice(0, 2000) : []);
const opt = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined)) as T;
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && ID.test(x)).slice(0, 2000) : []);
const IMG = /^[a-z0-9]{1,40}$/i;

export function parseProduction(raw: unknown, newId: () => string): Production | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const p = emptyProduction();
  p.locations = arr(r.locations).map((x) => opt({ id: id(x.id, newId), name: s(x.name, 120), address: s(x.address, 500), contact: s(x.contact), phone: s(x.phone, 60), map: s(x.map, 500), notes: s(x.notes, 2000), rate: n(x.rate) })).filter((x) => x.name) as LocationRec[];
  p.cast = arr(r.cast).map((x) => opt({ id: id(x.id, newId), character: s(x.character, 120), actor: s(x.actor, 120), phone: s(x.phone, 60), email: s(x.email, 200), notes: s(x.notes, 2000), rate: n(x.rate) })).filter((x) => x.character) as CastRec[];
  p.crew = arr(r.crew).map((x) => opt({ id: id(x.id, newId), name: s(x.name, 120), role: s(x.role, 120), dept: (CREW_DEPTS.includes(x.dept as CrewDept) ? x.dept : 'other') as CrewDept, phone: s(x.phone, 60), email: s(x.email, 200), rate: n(x.rate) })) as CrewRec[];
  p.days = arr(r.days).map((x) => {
    const calls: Record<string, string> = {};
    if (x.castCalls && typeof x.castCalls === 'object') for (const [k, v] of Object.entries(x.castCalls as Record<string, unknown>)) if (k.length <= 120 && typeof v === 'string') calls[k.toUpperCase()] = v.slice(0, 10);
    return opt({ id: id(x.id, newId), date: /^\d{4}-\d{2}-\d{2}$/.test(s(x.date)) ? s(x.date) : '', call: s(x.call, 10), wrap: s(x.wrap, 10), scenes: strs(x.scenes), castCalls: Object.keys(calls).length ? calls : undefined, notes: s(x.notes, 4000) }) as ShootDay;
  });
  p.wardrobe = arr(r.wardrobe).map((x) => opt({ id: id(x.id, newId), character: s(x.character, 120), label: s(x.label, 120), description: s(x.description, 2000), scenes: strs(x.scenes), img: IMG.test(s(x.img)) ? s(x.img) : '' })).filter((x) => x.character) as WardrobeChange[];
  p.budget = arr(r.budget).map((x) => {
    const link = x.link as Record<string, unknown> | undefined;
    return opt({
      id: id(x.id, newId),
      cat: (BUDGET_CATS.includes(x.cat as BudgetCat) ? x.cat : 'other') as BudgetCat,
      item: s(x.item, 200),
      qty: n(x.qty) ?? 1,
      unit: s(x.unit, 40),
      rate: n(x.rate) ?? 0,
      link: link && ['cast', 'crew', 'location'].includes(link.kind as string) && typeof link.id === 'string' ? { kind: link.kind as 'cast', id: link.id.slice(0, 80) } : undefined,
    }) as BudgetLine;
  });
  const cont = n(r.contingency);
  if (cont !== undefined && cont >= 0 && cont <= 100) p.contingency = cont;
  if (/^[A-Z]{3}$/.test(s(r.currency))) p.currency = s(r.currency);
  p.moodboards = arr(r.moodboards).map((b) => ({
    id: id(b.id, newId),
    title: s(b.title, 120),
    items: arr(b.items)
      .map((x) => opt({ id: id(x.id, newId), kind: (['image', 'color', 'note'].includes(x.kind as string) ? x.kind : 'note') as MoodItem['kind'], img: IMG.test(s(x.img)) ? s(x.img) : '', color: /^#[0-9a-f]{6}$/i.test(s(x.color)) ? s(x.color) : '', text: s(x.text, 2000) }) as MoodItem)
      .filter((x) => (x.kind === 'image' ? x.img : x.kind === 'color' ? x.color : x.text)),
  }));
  return p;
}

/** Image ids used by the production (wardrobe photos, moodboards). */
export function productionImageIds(p: Production | undefined, into: Set<string>) {
  if (!p) return into;
  for (const w of p.wardrobe) if (w.img) into.add(w.img);
  for (const b of p.moodboards) for (const it of b.items) if (it.img) into.add(it.img);
  return into;
}
