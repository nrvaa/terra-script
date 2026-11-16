/**
 * Read Aloud: the browser's speech synthesis reads the script from the cursor,
 * with a narrator voice for action and a different voice for every character.
 * Runs entirely in the browser (no audio leaves the device).
 */
import { t } from './i18n';
import { characterName, type Block } from './types';

const VOICES_KEY = 'tewrite:voices';

export interface ReaderOptions {
  bar: HTMLElement;
  getBlocks: () => Block[];
  startIndex: () => number;
  blockEl: (i: number) => HTMLElement | undefined;
  lang: () => string;
  onVoices: () => void;
}

interface Item {
  block: number;
  text: string;
  speaker: string | null;
}

const synth = (): SpeechSynthesis | null => ('speechSynthesis' in window ? window.speechSynthesis : null);

function loadVoiceMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(VOICES_KEY) || '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveVoiceMap(map: Record<string, string>) {
  try {
    localStorage.setItem(VOICES_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** Voices for the document language first (falls back to every voice). */
export function availableVoices(lang: string): SpeechSynthesisVoice[] {
  const all = synth()?.getVoices() ?? [];
  const base = lang.toLowerCase().split('-')[0];
  const match = all.filter((v) => v.lang.toLowerCase().startsWith(base));
  return match.length ? match : all;
}

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Voice for a speaker (null = narrator): the saved choice, else a stable automatic pick. */
export function voiceFor(speaker: string | null, lang: string, map = loadVoiceMap()): SpeechSynthesisVoice | null {
  const voices = availableVoices(lang);
  if (!voices.length) return null;
  const want = map[speaker ?? '#narrator'];
  const chosen = want ? voices.find((v) => v.voiceURI === want) : undefined;
  if (chosen) return chosen;
  if (speaker === null) return voices.find((v) => v.default) ?? voices[0];
  // Spread characters over the voices, skipping the narrator's when possible.
  const narrator = voiceFor(null, lang, map);
  const pool = voices.length > 1 ? voices.filter((v) => v !== narrator) : voices;
  return pool[hash(speaker) % pool.length];
}

/** Split long text: some browsers stop speaking after ~15 seconds. */
function chunks(text: string): string[] {
  const parts = text.match(/[^.!?…]+[.!?…]*["”’)]*\s*/g) ?? [text];
  const out: string[] = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > 220 && cur) {
      out.push(cur.trim());
      cur = '';
    }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function queueFrom(blocks: Block[], start: number): Item[] {
  const items: Item[] = [];
  let speaker: string | null = null;
  // If we start inside a speech, find who is talking.
  for (let i = start; i >= 0; i--) {
    const b = blocks[i];
    if (!b) continue;
    if (b.type === 'character') {
      speaker = characterName(b.text);
      break;
    }
    if (!['dialogue', 'parenthetical', 'lyrics'].includes(b.type)) break;
  }
  for (let i = Math.max(0, start); i < blocks.length; i++) {
    const b = blocks[i];
    const text = b.text.trim();
    if (b.type === 'character') {
      speaker = characterName(b.text);
      continue;
    }
    if (!['dialogue', 'parenthetical', 'lyrics'].includes(b.type)) speaker = null;
    if (!text || b.type === 'note' || b.type === 'section') continue;
    const said = b.type === 'parenthetical' ? text.replace(/^\(|\)$/g, '') : text;
    const voice = b.type === 'dialogue' || b.type === 'lyrics' ? speaker : null;
    for (const c of chunks(said)) items.push({ block: i, text: c, speaker: voice });
  }
  return items;
}

export function createReader(o: ReaderOptions) {
  let queue: Item[] = [];
  let pos = 0;
  let playing = false;
  let paused = false;
  let rate = 1;
  let current: HTMLElement | undefined;

  const status = o.bar.querySelector<HTMLElement>('[data-ra=status]')!;
  const playBtn = o.bar.querySelector<HTMLButtonElement>('[data-ra=play]')!;

  function mark(i: number | null) {
    current?.classList.remove('reading');
    current = i === null ? undefined : o.blockEl(i);
    if (current) {
      current.classList.add('reading');
      current.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function paint() {
    o.bar.hidden = !playing && !paused && !queue.length;
    playBtn.dataset.state = playing && !paused ? 'pause' : 'play';
    playBtn.title = playing && !paused ? t('ra.pause') : t('ra.play');
    playBtn.setAttribute('aria-label', playBtn.title);
    const item = queue[pos];
    status.textContent = item ? (item.speaker ?? t('ra.narrator')) : t('ra.done');
  }

  function speakNext() {
    const s = synth();
    if (!s || !playing) return;
    const item = queue[pos];
    if (!item) {
      stop(false);
      status.textContent = t('ra.done');
      return;
    }
    mark(item.block);
    const u = new SpeechSynthesisUtterance(item.text);
    const lang = o.lang();
    u.lang = lang;
    const v = voiceFor(item.speaker, lang);
    if (v) u.voice = v;
    u.rate = rate;
    u.onend = () => {
      if (!playing) return;
      pos++;
      speakNext();
    };
    u.onerror = (e) => {
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      pos++;
      speakNext();
    };
    s.speak(u);
    paint();
  }

  function start(from = o.startIndex()) {
    const s = synth();
    if (!s) return false;
    s.cancel();
    queue = queueFrom(o.getBlocks(), Math.max(0, from));
    pos = 0;
    playing = true;
    paused = false;
    o.bar.hidden = false;
    speakNext();
    return true;
  }

  function stop(hide = true) {
    playing = false;
    paused = false;
    synth()?.cancel();
    mark(null);
    if (hide) {
      queue = [];
      o.bar.hidden = true;
    }
    paint();
  }

  function toggle() {
    const s = synth();
    if (!s) return;
    if (!playing) {
      start();
      return;
    }
    if (paused) {
      paused = false;
      s.resume();
    } else {
      paused = true;
      s.pause();
    }
    paint();
  }

  function skip(dir: 1 | -1) {
    if (!queue.length) return;
    const curBlock = queue[pos]?.block ?? -1;
    let k = pos;
    if (dir > 0) while (k < queue.length && queue[k].block === curBlock) k++;
    else {
      while (k > 0 && queue[k - 1].block === curBlock) k--;
      if (k > 0) {
        const prev = queue[k - 1].block;
        k--;
        while (k > 0 && queue[k - 1].block === prev) k--;
      }
    }
    pos = Math.max(0, Math.min(k, queue.length));
    synth()?.cancel();
    paused = false;
    playing = true;
    speakNext();
  }

  o.bar.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-ra]')?.dataset.ra;
    if (act === 'play') toggle();
    else if (act === 'stop') stop();
    else if (act === 'next') skip(1);
    else if (act === 'prev') skip(-1);
    else if (act === 'voices') o.onVoices();
  });
  o.bar.querySelector<HTMLSelectElement>('[data-ra=rate]')?.addEventListener('change', (e) => {
    rate = Number((e.target as HTMLSelectElement).value) || 1;
    if (playing && !paused) {
      synth()?.cancel();
      speakNext();
    }
  });
  // Voices load asynchronously in some browsers.
  synth()?.addEventListener?.('voiceschanged', () => undefined);
  window.addEventListener('pagehide', () => synth()?.cancel());

  return {
    supported: () => Boolean(synth()),
    start,
    stop: () => stop(),
    toggle,
    isPlaying: () => playing,
  };
}

export { loadVoiceMap };
