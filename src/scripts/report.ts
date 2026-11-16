/**
 * Script statistics and per-character breakdown, shared by the side panel
 * and the export options (PDF / Fountain / plain text).
 */
import { t, type Key } from './i18n';
import { layoutScript } from './pdf';
import { SCENE_PREFIX, characterName, sceneTakeStatus, type Block, type Take } from './types';

export interface CharacterStat {
  name: string;
  dialogues: number; // number of speeches
  words: number; // words spoken
  scenes: Set<number>; // scene numbers they speak in
  firstScene: number; // 0 = before the first scene heading
}

export interface ScriptStats {
  pages: number;
  scenes: number;
  interior: number;
  exterior: number;
  day: number;
  night: number;
  words: number;
  dialogueWords: number;
  speeches: number;
  speaking: number;
  notes: number;
}

const countWords = (s: string) => s.trim().match(/\S+/g)?.length ?? 0;
const DAY = /\b(DAY|SIANG|PAGI|MORNING|AFTERNOON|SORE|DAWN|SUBUH)\b/;
const NIGHT = /\b(NIGHT|MALAM|EVENING|DUSK|MIDNIGHT|PETANG)\b/;

export function characterStats(blocks: Block[]): CharacterStat[] {
  const chars = new Map<string, CharacterStat>();
  let scene = 0;
  let speaker: CharacterStat | null = null;
  for (const b of blocks) {
    if (b.type === 'scene') scene++;
    if (b.type === 'character') {
      const name = characterName(b.text);
      if (!name) {
        speaker = null;
        continue;
      }
      let c = chars.get(name);
      if (!c) {
        c = { name, dialogues: 0, words: 0, scenes: new Set(), firstScene: scene };
        chars.set(name, c);
      }
      c.dialogues++;
      if (scene) c.scenes.add(scene);
      speaker = c;
    } else if ((b.type === 'dialogue' || b.type === 'lyrics') && speaker) {
      speaker.words += countWords(b.text);
    } else if (b.type !== 'parenthetical') speaker = null;
  }
  return [...chars.values()].sort((a, b) => b.dialogues - a.dialogues || b.words - a.words || a.name.localeCompare(b.name));
}

export function scriptStats(blocks: Block[], paper: 'letter' | 'a4'): ScriptStats {
  const s: ScriptStats = {
    pages: 1, scenes: 0, interior: 0, exterior: 0, day: 0, night: 0,
    words: 0, dialogueWords: 0, speeches: 0, speaking: 0, notes: 0,
  };
  for (const b of blocks) {
    const up = b.text.toUpperCase();
    if (b.type === 'scene') {
      s.scenes++;
      const prefix = up.match(SCENE_PREFIX)?.[1] ?? '';
      if (/INT/.test(prefix)) s.interior++;
      if (/EXT/.test(prefix) || prefix === 'EST') s.exterior++;
      const time = up.split(' - ').slice(1).join(' - ');
      if (DAY.test(time)) s.day++;
      else if (NIGHT.test(time)) s.night++;
    }
    if (b.type === 'note') s.notes++;
    else s.words += countWords(b.text);
    if (b.type === 'dialogue' || b.type === 'lyrics') s.dialogueWords += countWords(b.text);
    if (b.type === 'character') s.speeches++;
  }
  s.speaking = characterStats(blocks).length;
  try {
    s.pages = Math.max(1, layoutScript(blocks, { paper, sceneNumbers: false }).length);
  } catch {
    /* keep 1 */
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* Report as fixed-width lines (60 columns = the screenplay text area)  */
/* ------------------------------------------------------------------ */

export interface ReportLine {
  text: string;
  bold?: boolean;
  underline?: boolean;
  center?: boolean;
}

export interface ReportOptions {
  stats: boolean;
  characters: boolean;
  takes?: boolean;
  title: string;
  paper: 'letter' | 'a4';
  locale: string;
}

const WIDTH = 60;

function leader(label: string, value: string): string {
  const dots = WIDTH - label.length - value.length - 2;
  return dots >= 3 ? `${label} ${'.'.repeat(dots)} ${value}` : `${label}: ${value}`;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function buildReport(blocks: Block[], opts: ReportOptions): ReportLine[] {
  const n = (v: number) => v.toLocaleString(opts.locale);
  const lines: ReportLine[] = [];
  const blank = () => lines.push({ text: '' });

  lines.push({ text: t('rep.title').toUpperCase(), bold: true, underline: true, center: true });
  if (opts.title.trim()) lines.push({ text: opts.title.trim().toUpperCase(), center: true });
  lines.push({ text: new Date().toLocaleDateString(opts.locale, { day: 'numeric', month: 'long', year: 'numeric' }), center: true });

  if (opts.stats) {
    const s = scriptStats(blocks, opts.paper);
    blank();
    blank();
    lines.push({ text: t('rep.stats').toUpperCase(), bold: true });
    blank();
    const rows: [string, string][] = [
      [t('stat.pages'), n(s.pages)],
      [t('rep.runtime'), t('stat.runtimeVal', { n: s.pages })],
      [t('stat.scenes'), n(s.scenes)],
      [`  ${t('stat.intExt')}`, `${n(s.interior)} / ${n(s.exterior)}`],
      [`  ${t('rep.dayNight')}`, `${n(s.day)} / ${n(s.night)}`],
      [t('stat.speaking'), n(s.speaking)],
      [t('rep.speeches'), n(s.speeches)],
      [t('stat.words'), n(s.words)],
      [t('rep.dialogueWords'), n(s.dialogueWords)],
      [t('stat.dialogueRatio'), s.words ? `${Math.round((s.dialogueWords / s.words) * 100)}%` : '–'],
    ];
    for (const [label, value] of rows) lines.push({ text: leader(label, value) });
  }

  if (opts.characters) {
    const chars = characterStats(blocks);
    blank();
    blank();
    lines.push({ text: t('rep.characters').toUpperCase(), bold: true });
    blank();
    if (!chars.length) {
      lines.push({ text: t('rep.noCharacters') });
    } else {
      // NAME(24) DIALOGUES(10) WORDS(9) SCENES(8) FIRST(7) = 58 columns
      const col = (s: string, w: number) => s.padStart(w);
      const head =
        clip(t('rep.colName').toUpperCase(), 24).padEnd(24) +
        col(clip(t('rep.colDialogues').toUpperCase(), 9), 10) +
        col(clip(t('rep.colWords').toUpperCase(), 8), 9) +
        col(clip(t('rep.colScenes').toUpperCase(), 7), 8) +
        col(clip(t('rep.colFirst').toUpperCase(), 6), 7);
      lines.push({ text: head, bold: true });
      lines.push({ text: '-'.repeat(head.length) });
      for (const c of chars) {
        lines.push({
          text:
            clip(c.name, 24).padEnd(24) +
            col(n(c.dialogues), 10) +
            col(n(c.words), 9) +
            col(n(c.scenes.size), 8) +
            col(c.firstScene ? String(c.firstScene) : '–', 7),
        });
      }
      blank();
      for (const l of wrapPlain(t('rep.charNote'), WIDTH)) lines.push({ text: l });
    }
  }

  if (opts.takes) {
    blank();
    blank();
    lines.push({ text: t('take.title').toUpperCase(), bold: true });
    blank();
    const scenes: { no: number; heading: string; takes: Take[] }[] = [];
    let no = 0;
    for (const b of blocks) {
      if (b.type !== 'scene') continue;
      no++;
      scenes.push({ no, heading: b.text.trim().toUpperCase(), takes: b.takes ?? [] });
    }
    const all = scenes.flatMap((s) => s.takes);
    const by = (st: string) => all.filter((x) => x.status === st).length;
    const shot = scenes.filter((s) => s.takes.length).length;
    lines.push({ text: leader(t('rep.takesTotal'), n(all.length)) });
    lines.push({ text: leader(`  ${t('take.good')} / ${t('take.maybe')} / ${t('take.skip')}`, `${n(by('good'))} / ${n(by('maybe'))} / ${n(by('skip'))}`) });
    lines.push({ text: leader(t('rep.scenesShot'), `${n(shot)} / ${n(scenes.length)}`) });
    lines.push({ text: leader(t('rep.scenesGood'), `${n(scenes.filter((s) => sceneTakeStatus(s.takes) === 'good').length)} / ${n(scenes.length)}`) });

    if (!all.length) {
      blank();
      lines.push({ text: t('rep.noTakes') });
    }
    // SLATE(8) TAKE(6) CAM(5) ROLL(7) STATUS(8) NOTE(rest)
    const head =
      clip(t('take.slate').toUpperCase(), 7).padEnd(8) +
      clip(t('take.take').toUpperCase(), 5).padEnd(6) +
      clip(t('take.camera').toUpperCase(), 4).padEnd(5) +
      clip(t('take.roll').toUpperCase(), 6).padEnd(7) +
      clip(t('rep.colStatus').toUpperCase(), 7).padEnd(8) +
      t('take.note').toUpperCase();
    for (const s of scenes) {
      if (!s.takes.length) continue;
      blank();
      lines.push({ text: clip(`${s.no}. ${s.heading || t('nav.untitledScene')}`, WIDTH), bold: true });
      lines.push({ text: head });
      lines.push({ text: '-'.repeat(WIDTH) });
      for (const tk of s.takes) {
        const status = tk.status ? t(`take.${tk.status}` as Key).toUpperCase() : '–';
        const left =
          clip(tk.slate || '–', 7).padEnd(8) +
          clip(tk.take || '–', 5).padEnd(6) +
          clip(tk.camera || '–', 4).padEnd(5) +
          clip(tk.roll || '–', 6).padEnd(7) +
          clip(status, 7).padEnd(8);
        const noteLines = tk.note.trim() ? wrapPlain(tk.note.trim(), WIDTH - left.length) : [''];
        lines.push({ text: (left + noteLines[0]).trimEnd() });
        for (const extra of noteLines.slice(1)) lines.push({ text: ' '.repeat(left.length) + extra });
      }
    }
  }
  return lines;
}

function wrapPlain(text: string, width: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/)) {
    if (cur && (cur + ' ' + w).length > width) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out;
}

/** Report as plain text, centred within the 60-column text area. */
export function reportToText(lines: ReportLine[]): string {
  return lines
    .map((l) => (l.center ? ' '.repeat(Math.max(0, Math.floor((WIDTH - l.text.length) / 2))) + l.text : l.text))
    .join('\n');
}
