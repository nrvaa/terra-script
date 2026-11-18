/**
 * Revisions, Production, Tools and Customize: everything behind those menus.
 * app.ts owns the document state and hands it in through `ctx`.
 */
import type { ScreenplayEditor } from './editor';
import { t, type Key, type Lang } from './i18n';
import { blockPages, pageAnchors, type LaidPage, type LayoutOptions } from './pdf';
import {
  createProject,
  deleteSnapshot,
  duplicateProject,
  editorUrl,
  listSnapshots,
  renameSnapshot,
  saveSnapshot,
  type Snapshot,
} from './projects';
import { createReader, availableVoices, loadVoiceMap, saveVoiceMap, voiceFor } from './readaloud';
import { acceptHunk, changedBlocks, counterpart, diffLines, rejectHunk, toLines, type Hunk, type Line } from './revisions';
import type { Flag } from './rich';
import { findTightSpots } from './shorten';
import { breakdown, breakdownCsv, catLabel, paintTags, tagRegex, tagSceneCounts, untaggedCast } from './tagger';
import {
  DEFAULT_FOOTER,
  DEFAULT_HEADER,
  DEFAULT_STYLES,
  ELEMENTS,
  LABELS,
  REV_COLORS,
  REV_HEX,
  TAG_CATS,
  TAG_HEX,
  autoContdCues,
  elementStyle,
  sceneLabels,
  type Block,
  type ElType,
  type ElementStyle,
  type RevColor,
  type Revision,
  type ScriptDoc,
  type ScriptLayout,
  type Tag,
  type TagCat,
  type TitlePage,
} from './types';

export interface FeatureSettings {
  autocomplete: boolean;
  smartType: boolean;
  typewriter: boolean;
  spellcheck: boolean;
  showRevisions: boolean;
  showTags: boolean;
  showNotes: boolean;
  backupReminders: boolean;
  autoSnapshots: boolean;
  docLang: string;
  writer: string;
  pageMarkers: boolean;
  sceneNumbers: boolean;
  paper: 'letter' | 'a4';
  theme: 'light' | 'dark' | 'system';
  paperColor: 'auto' | 'light' | 'dark';
  lang: Lang;
}

export interface AppCtx {
  editor: ScreenplayEditor;
  editorEl: HTMLElement;
  paper: HTMLElement;
  settings: FeatureSettings;
  projectId: string | null;
  /** Save settings and re-apply them to the UI (re-lays the pages). */
  applySettings(): void;
  /** Script-level layout (paper, numbering, headers…). */
  layout(): ScriptLayout;
  setLayout(patch: Partial<ScriptLayout>): void;
  revision(): Revision | undefined;
  setRevision(r: Revision | undefined): void;
  tags(): Tag[];
  setTags(tags: Tag[]): void;
  titlePage(): TitlePage;
  setTitlePage(tp: TitlePage): void;
  currentDoc(): ScriptDoc;
  lastLayout(): LaidPage[];
  saveNow(): Promise<void>;
  toast(msg: string): void;
  download(name: string, content: string, type: string): Promise<boolean>;
  fileBase(): string;
  sceneAt(index: number): number | null;
  setSidebarTab(tab: string): void;
  showSidebar(): void;
  applyLanguage(lang: Lang): void;
  relTime(ts: number): string;
  locale(): string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const today = (locale: string) => new Date().toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' });

export const DOC_LANGS: { code: string; name: string }[] = [
  { code: 'en-US', name: 'English (US)' },
  { code: 'en-GB', name: 'English (UK)' },
  { code: 'id-ID', name: 'Bahasa Indonesia' },
  { code: 'ms-MY', name: 'Bahasa Melayu' },
  { code: 'es-ES', name: 'Español' },
  { code: 'fr-FR', name: 'Français' },
  { code: 'de-DE', name: 'Deutsch' },
  { code: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'ja-JP', name: '日本語' },
  { code: 'ko-KR', name: '한국어' },
  { code: 'zh-CN', name: '中文' },
];

const ICON = {
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  go: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  compare: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v18"/><path d="M16 3v18"/><path d="M3 8h5M16 16h5"/></svg>',
};

/**
 * Toggle switch (Uiverse.io by Galahhad): a pill with a sliding knob that
 * shows a cross when off and a check mark when on. Goes inside a <label>.
 */
export function switchHtml(attrs: string, on: boolean, small = false): string {
  return `<span class="tswitch${small ? ' tswitch-sm' : ''}"><input type="checkbox" ${attrs}${on ? ' checked' : ''} /><span class="slider" aria-hidden="true"><span class="circle"><svg class="cross" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg><svg class="checkmark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5L20 7"/></svg></span></span></span>`;
}

export function initFeatures(ctx: AppCtx) {
  const { editor, editorEl, settings } = ctx;

  /* ------------------------------------------------------------------ */
  /* Dialog helper                                                        */
  /* ------------------------------------------------------------------ */

  function dialog(id: string, wide = true): HTMLDialogElement {
    let d = document.getElementById(id) as HTMLDialogElement | null;
    if (!d) {
      d = document.createElement('dialog');
      d.id = id;
      d.className = `dialog${wide ? ' dialog-wide' : ''} feat-dialog`;
      d.addEventListener('click', (e) => {
        if (e.target === d) d!.close();
        if ((e.target as HTMLElement).closest('[data-close]')) d!.close();
      });
      d.addEventListener('close', () => {
        if (!document.querySelector('dialog[open]')) editor.focus();
      });
      document.body.appendChild(d);
    }
    return d;
  }

  // Menu labels end in "…"; dialog titles don't.
  const head = (title: string, sub = '') =>
    `<div class="fd-head"><div><h2 class="text-lg font-semibold">${esc(title.replace(/…$/, ''))}</h2>${sub ? `<p class="fd-sub">${sub}</p>` : ''}</div><button type="button" class="fd-x" data-close aria-label="${esc(t('btn.close'))}">${ICON.x}</button></div>`;

  const toggle = (k: string, label: string, desc: string, on: boolean) =>
    `<label class="set-row"><span><span class="set-label">${esc(label)}</span>${desc ? `<span class="set-desc">${esc(desc)}</span>` : ''}</span>${switchHtml(`data-k="${k}"`, on)}</label>`;

  const select = (k: string, label: string, options: [string, string][], value: string, desc = '') =>
    `<label class="set-row"><span><span class="set-label">${esc(label)}</span>${desc ? `<span class="set-desc">${esc(desc)}</span>` : ''}</span><select class="text-input set-select" data-k="${k}">${options
      .map(([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`)
      .join('')}</select></label>`;

  const input = (k: string, label: string, value: string, placeholder = '', desc = '') =>
    `<label class="set-row set-row-input"><span><span class="set-label">${esc(label)}</span>${desc ? `<span class="set-desc">${esc(desc)}</span>` : ''}</span><input class="text-input" data-k="${k}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false" /></label>`;

  /* ------------------------------------------------------------------ */
  /* Revisions state                                                     */
  /* ------------------------------------------------------------------ */

  let revCache: { key: string; changed: Set<number>; deleted: Set<number>; hunks: Hunk[] } | null = null;

  function revisionState(blocks: Block[]) {
    const rev = ctx.revision();
    const key = rev?.baseline ? `${rev.baseline.length}:${blocks.length}:${JSON.stringify(toLines(blocks))}${JSON.stringify(rev.baseline)}` : '';
    if (revCache && revCache.key === key && key) return revCache;
    const r = rev?.baseline ? changedBlocks(rev.baseline, blocks) : { changed: new Set<number>(), deletedBefore: new Set<number>(), hunks: [] };
    revCache = { key, changed: r.changed, deleted: r.deletedBefore, hunks: r.hunks };
    return revCache;
  }

  /** Revised blocks: tracked changes plus manual marks. */
  function revisedSet(blocks: Block[]): Set<number> {
    const s = new Set(revisionState(blocks).changed);
    blocks.forEach((b, i) => b.mark && s.add(i));
    return s;
  }

  const revLabel = () => {
    const r = ctx.revision();
    if (!r) return '';
    return `${t(`rev.${r.color}` as Key)} ${t('rev.rev')} ${r.date}`.trim();
  };

  /** Everything the pagination needs (used for the screen and the PDF). */
  function layoutOptions(blocks: Block[]): LayoutOptions {
    const l = ctx.layout();
    const revised = l.revMarks !== false ? revisedSet(blocks) : undefined;
    return { ...l, revised, revLabel: revLabel(), title: ctx.titlePage().title };
  }

  /* ------------------------------------------------------------------ */
  /* Screen decorations                                                  */
  /* ------------------------------------------------------------------ */

  const revLayer = document.createElement('div');
  revLayer.id = 'rev-layer';
  revLayer.setAttribute('aria-hidden', 'true');
  ctx.paper.appendChild(revLayer);
  const customCss = document.createElement('style');
  customCss.id = 'custom-format';
  document.head.appendChild(customCss);

  /** Scene numbers, auto CONT'D, revision marks, tags, custom formats on screen. */
  function refreshScreen() {
    const blocks = editor.getBlocks();
    const els = editorEl.children;
    const l = ctx.layout();
    const labels = sceneLabels(blocks, l);
    const contd = l.autoContd !== false ? autoContdCues(blocks) : new Set<number>();
    const word = `(${(l.contdText || "CONT'D").trim()})`;
    const showRev = settings.showRevisions;
    const rs = showRev ? revisionState(blocks) : null;
    const revised = showRev ? revisedSet(blocks) : new Set<number>();
    const r = ctx.revision();
    editorEl.style.setProperty('--rev-color', REV_HEX[r?.color ?? 'blue']);
    editorEl.dataset.numSide = l.sceneNumberSide ?? 'both';
    blocks.forEach((b, i) => {
      const el = els[i] as HTMLElement | undefined;
      if (!el) return;
      const label = labels.get(i);
      if (label !== undefined) el.dataset.label = label;
      else delete el.dataset.label;
      if (contd.has(i)) el.dataset.autoContd = word;
      else delete el.dataset.autoContd;
      if (revised.has(i)) el.dataset.rev = '1';
      else delete el.dataset.rev;
    });
    // Asterisks in the right margin + a marker where text was deleted.
    if (showRev && (revised.size || rs?.deleted.size)) {
      const out: string[] = [];
      // Blocks are positioned relative to #paper, like this layer.
      const top = (el: HTMLElement) => el.offsetTop;
      for (const i of revised) {
        const el = els[i] as HTMLElement | undefined;
        if (el) out.push(`<span class="rev-star" style="top:${top(el)}px;height:${el.offsetHeight}px">*</span>`);
      }
      for (const i of rs?.deleted ?? []) {
        const el = (els[i] ?? els[els.length - 1]) as HTMLElement | undefined;
        if (el) out.push(`<span class="rev-del" style="top:${i < els.length ? top(el) - 6 : top(el) + el.offsetHeight + 2}px" title="${esc(t('rev.deletedHere'))}"></span>`);
      }
      revLayer.innerHTML = out.join('');
    } else revLayer.innerHTML = '';
    paintTags(editorEl, ctx.tags(), settings.showTags);
    applyCustomFormat();
  }

  function applyCustomFormat() {
    const styles = ctx.layout().styles ?? {};
    const rules: string[] = [];
    for (const [type, s] of Object.entries(styles) as [ElType, Partial<ElementStyle>][]) {
      if (!s) continue;
      const sel = `.script .el[data-type="${type}"]`;
      const d = DEFAULT_STYLES[type];
      const st = { ...d, ...s };
      const decl: string[] = [];
      if (st.caps !== d.caps) decl.push(`text-transform:${st.caps ? 'uppercase' : 'none'}`);
      if (st.bold !== d.bold) decl.push(`font-weight:${st.bold ? 700 : 400}`);
      if (st.italic !== d.italic) decl.push(`font-style:${st.italic ? 'italic' : 'normal'}`);
      if (st.underline !== d.underline) decl.push(`text-decoration:${st.underline ? 'underline' : 'none'}`);
      if (st.before !== d.before) decl.push(`margin-top:calc(var(--line) * ${st.before})`);
      if (decl.length) rules.push(`${sel}{${decl.join(';')}}`);
    }
    customCss.textContent = rules.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /* Menu check states                                                   */
  /* ------------------------------------------------------------------ */

  function currentScene(): number | null {
    const i = editor.currentIndex();
    return i >= 0 ? ctx.sceneAt(i) : null;
  }

  function check(key: string): boolean | undefined {
    const blocks = () => editor.getBlocks();
    switch (key) {
      case 'tracking':
        return Boolean(ctx.revision()?.baseline);
      case 'showRevisions':
        return settings.showRevisions;
      case 'pagesLocked':
        return Boolean(ctx.layout().pagesLocked);
      case 'curSceneNewPage': {
        const s = currentScene();
        return s !== null && Boolean(blocks()[s]?.newPage);
      }
      case 'curSceneOmitted': {
        const s = currentScene();
        return s !== null && Boolean(blocks()[s]?.omit?.length);
      }
      case 'fmt=b':
      case 'fmt=i':
      case 'fmt=u':
      case 'fmt=s':
        return editor.formatActive(key.slice(4) as Flag);
      case 'reading':
        return reader.isPlaying();
    }
    return undefined;
  }

  /* ------------------------------------------------------------------ */
  /* Formatting toolbar                                                  */
  /* ------------------------------------------------------------------ */

  const fmtButtons = Array.from(document.querySelectorAll<HTMLElement>('[data-fmt]'));
  for (const b of fmtButtons) {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      editor.toggleFormat(b.dataset.fmt as Flag);
      updateFormatButtons();
    });
  }
  function updateFormatButtons() {
    for (const b of fmtButtons) b.setAttribute('aria-pressed', String(editor.formatActive(b.dataset.fmt as Flag)));
  }

  /* ------------------------------------------------------------------ */
  /* Customize (settings dialog with tabs)                               */
  /* ------------------------------------------------------------------ */

  type Tab = 'editing' | 'display' | 'format' | 'notifications' | 'pdf' | 'page' | 'misc';
  const TABS: Tab[] = ['editing', 'display', 'format', 'notifications', 'pdf', 'page', 'misc'];

  function setLayout(patch: Partial<ScriptLayout>) {
    ctx.setLayout(patch);
    refreshScreen();
  }

  /** Every control in the settings dialog: how to read and write it. */
  const controls: Record<string, { get: () => unknown; set: (v: never) => void }> = {
    autocomplete: { get: () => settings.autocomplete, set: (v: boolean) => ((settings.autocomplete = v), ctx.applySettings()) },
    smartType: { get: () => settings.smartType, set: (v: boolean) => ((settings.smartType = v), ctx.applySettings()) },
    typewriter: { get: () => settings.typewriter, set: (v: boolean) => ((settings.typewriter = v), ctx.applySettings()) },
    spellcheck: { get: () => settings.spellcheck, set: (v: boolean) => ((settings.spellcheck = v), ctx.applySettings()) },
    sceneNumbers: { get: () => settings.sceneNumbers, set: (v: boolean) => setLayout({ sceneNumbers: v }) },
    sceneNumberSide: { get: () => ctx.layout().sceneNumberSide ?? 'both', set: (v: 'left') => setLayout({ sceneNumberSide: v }) },
    pageMarkers: { get: () => settings.pageMarkers, set: (v: boolean) => ((settings.pageMarkers = v), ctx.applySettings()) },
    showRevisions: { get: () => settings.showRevisions, set: (v: boolean) => ((settings.showRevisions = v), ctx.applySettings(), refreshScreen()) },
    showTags: { get: () => settings.showTags, set: (v: boolean) => ((settings.showTags = v), ctx.applySettings(), refreshScreen()) },
    showNotes: { get: () => settings.showNotes, set: (v: boolean) => ((settings.showNotes = v), ctx.applySettings()) },
    theme: { get: () => settings.theme, set: (v: 'light') => ((settings.theme = v), ctx.applySettings()) },
    paperColor: { get: () => settings.paperColor, set: (v: 'auto') => ((settings.paperColor = v), ctx.applySettings()) },
    backupReminders: { get: () => settings.backupReminders, set: (v: boolean) => ((settings.backupReminders = v), ctx.applySettings()) },
    autoSnapshots: { get: () => settings.autoSnapshots, set: (v: boolean) => ((settings.autoSnapshots = v), ctx.applySettings()) },
    revMarks: { get: () => ctx.layout().revMarks !== false, set: (v: boolean) => setLayout({ revMarks: v }) },
    watermark: { get: () => ctx.layout().watermark ?? '', set: (v: string) => setLayout({ watermark: v.trim() || undefined }) },
    firstPageHeader: { get: () => Boolean(ctx.layout().firstPageHeader), set: (v: boolean) => setLayout({ firstPageHeader: v }) },
    paper: { get: () => settings.paper, set: (v: 'letter') => setLayout({ paper: v }) },
    more: { get: () => ctx.layout().more !== false, set: (v: boolean) => setLayout({ more: v }) },
    autoContd: { get: () => ctx.layout().autoContd !== false, set: (v: boolean) => setLayout({ autoContd: v }) },
    sceneContinueds: { get: () => Boolean(ctx.layout().sceneContinueds), set: (v: boolean) => setLayout({ sceneContinueds: v }) },
    lang: { get: () => settings.lang, set: (v: Lang) => ctx.applyLanguage(v) },
    docLang: { get: () => settings.docLang, set: (v: string) => ((settings.docLang = v), ctx.applySettings()) },
    writer: { get: () => settings.writer, set: (v: string) => ((settings.writer = v.trim()), ctx.applySettings()) },
  };

  function settingsTab(tab: Tab): string {
    const c = (k: string) => controls[k].get();
    switch (tab) {
      case 'editing':
        return [
          toggle('autocomplete', t('set.autocomplete'), t('set.autocompleteDesc'), c('autocomplete') as boolean),
          toggle('smartType', t('set.smartType'), t('set.smartTypeDesc'), c('smartType') as boolean),
          toggle('typewriter', t('set.typewriter'), t('set.typewriterDesc'), c('typewriter') as boolean),
          toggle('spellcheck', t('set.spellcheck'), t('set.spellcheckDesc'), c('spellcheck') as boolean),
        ].join('');
      case 'display':
        return [
          toggle('sceneNumbers', t('m.sceneNumbers'), '', c('sceneNumbers') as boolean),
          select('sceneNumberSide', t('set.numberSide'), [['left', t('set.left')], ['right', t('set.right')], ['both', t('set.both')]], c('sceneNumberSide') as string),
          toggle('pageMarkers', t('set.pageView'), t('set.pageViewDesc'), c('pageMarkers') as boolean),
          toggle('showRevisions', t('m.showChanges'), t('set.showRevisionsDesc'), c('showRevisions') as boolean),
          toggle('showTags', t('set.showTags'), t('set.showTagsDesc'), c('showTags') as boolean),
          toggle('showNotes', t('set.showNotes'), t('set.showNotesDesc'), c('showNotes') as boolean),
          select('theme', t('proj.theme'), [['light', t('m.themeLight')], ['dark', t('m.themeDark')], ['system', t('m.themeSystem')]], c('theme') as string),
          select('paperColor', t('st.paper'), [['auto', t('st.paperAuto')], ['light', t('st.paperLight')], ['dark', t('st.paperDark')]], c('paperColor') as string),
        ].join('');
      case 'format': {
        const l = ctx.layout();
        const rows = ELEMENTS.filter((e) => !['note', 'section'].includes(e.type))
          .map((e) => {
            const s = elementStyle(l, e.type);
            const cb = (f: keyof ElementStyle) =>
              `<td><input type="checkbox" data-style="${e.type}:${f}" aria-label="${esc(`${e.label} ${t(`fmt.${f}` as Key)}`)}"${s[f] ? ' checked' : ''} /></td>`;
            return `<tr><th scope="row">${esc(e.label)}</th>${cb('caps')}${cb('bold')}${cb('italic')}${cb('underline')}<td><select class="fmt-before" data-style="${e.type}:before" aria-label="${esc(`${e.label} ${t('fmt.before')}`)}">${[0, 1, 2, 3]
              .map((n) => `<option value="${n}"${n === s.before ? ' selected' : ''}>${n}</option>`)
              .join('')}</select></td></tr>`;
          })
          .join('');
        return `<p class="set-desc mb-2">${esc(t('fmt.intro'))}</p>
          <div class="fmt-table-wrap"><table class="fmt-table"><thead><tr><th></th><th>${esc(t('fmt.caps'))}</th><th><b>B</b></th><th><i>I</i></th><th><u>U</u></th><th>${esc(t('fmt.before'))}</th></tr></thead><tbody>${rows}</tbody></table></div>
          <div class="flex justify-end pt-2"><button type="button" class="btn" data-act="reset-format">${esc(t('fmt.reset'))}</button></div>`;
      }
      case 'notifications':
        return [
          toggle('backupReminders', t('set.backupReminders'), t('set.backupRemindersDesc'), c('backupReminders') as boolean),
          toggle('autoSnapshots', t('set.autoSnapshots'), t('set.autoSnapshotsDesc'), c('autoSnapshots') as boolean),
        ].join('');
      case 'pdf':
        return [
          toggle('revMarks', t('set.revMarks'), t('set.revMarksDesc'), c('revMarks') as boolean),
          input('watermark', t('m.watermark'), c('watermark') as string, t('wm.placeholder'), t('set.watermarkDesc')),
          toggle('firstPageHeader', t('hf.firstPage'), t('hf.firstPageDesc'), c('firstPageHeader') as boolean),
          `<div class="set-links"><button type="button" class="btn" data-act="headers">${esc(t('m.headersFooters'))}</button><button type="button" class="btn" data-act="mores">${esc(t('m.moresContds'))}</button></div>`,
        ].join('');
      case 'page':
        return [
          select('paper', t('set.paper'), [['letter', t('m.letter')], ['a4', t('m.a4')]], c('paper') as string),
          toggle('more', t('mc.more'), t('mc.moreDesc'), c('more') as boolean),
          toggle('autoContd', t('mc.autoContd'), t('mc.autoContdDesc'), c('autoContd') as boolean),
          toggle('sceneContinueds', t('mc.sceneContinueds'), t('mc.sceneContinuedsDesc'), c('sceneContinueds') as boolean),
          `<div class="set-links"><button type="button" class="btn" data-act="lock-pages">${esc(ctx.layout().pagesLocked ? t('lp.unlock') : t('lp.lock'))}</button><button type="button" class="btn" data-act="scene-numbers">${esc(t('m.sceneNumbersDlg'))}</button></div>`,
        ].join('');
      case 'misc':
        return [
          select('lang', t('set.uiLang'), [['en', 'English'], ['id', 'Bahasa Indonesia']], c('lang') as string),
          select('docLang', t('set.docLang'), DOC_LANGS.map((l) => [l.code, l.name] as [string, string]), c('docLang') as string, t('set.docLangDesc')),
          input('writer', t('set.writer'), c('writer') as string, t('set.writerPh'), t('set.writerDesc')),
        ].join('');
    }
  }

  function openSettings(tab: Tab = 'editing') {
    const d = dialog('dlg-settings');
    const render = (active: Tab) => {
      d.innerHTML = `${head(t('menu.customize'))}
        <div class="set-wrap">
          <div class="set-tabs" role="tablist" aria-label="${esc(t('menu.customize'))}">${TABS.map(
            (k) => `<button type="button" role="tab" data-tab-set="${k}" aria-selected="${k === active}">${esc(t(`set.tab.${k}` as Key))}</button>`,
          ).join('')}</div>
          <div class="set-body" role="tabpanel">${settingsTab(active)}</div>
        </div>
        <div class="flex justify-end pt-3"><button type="button" class="btn btn-primary" data-close><span>${esc(t('set.done'))}</span></button></div>`;
      d.dataset.tab = active;
    };
    render(tab);
    d.onchange = (e) => {
      const el = e.target as HTMLInputElement | HTMLSelectElement;
      const k = el.dataset.k;
      if (k && controls[k]) {
        const v = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value;
        (controls[k].set as (v: unknown) => void)(v);
        // Language changes re-translate the dialog too.
        if (k === 'lang') render(d.dataset.tab as Tab);
        return;
      }
      const st = el.dataset.style;
      if (st) {
        const [type, f] = st.split(':') as [ElType, keyof ElementStyle];
        const styles = { ...(ctx.layout().styles ?? {}) };
        const cur = { ...(styles[type] ?? {}) } as Partial<ElementStyle>;
        if (f === 'before') cur.before = Number(el.value);
        else (cur as Record<string, boolean>)[f] = (el as HTMLInputElement).checked;
        // Only store what differs from the default.
        for (const key of Object.keys(cur) as (keyof ElementStyle)[]) if (cur[key] === DEFAULT_STYLES[type][key]) delete cur[key];
        if (Object.keys(cur).length) styles[type] = cur;
        else delete styles[type];
        setLayout({ styles: Object.keys(styles).length ? styles : undefined });
      }
    };
    d.oninput = (e) => {
      const el = e.target as HTMLInputElement;
      if (el.dataset.k && el.type !== 'checkbox' && el.tagName === 'INPUT') {
        window.clearTimeout(inputTimer);
        inputTimer = window.setTimeout(() => (controls[el.dataset.k!].set as (v: unknown) => void)(el.value), 350);
      }
    };
    d.onclick = settingsClick;
    if (!d.open) d.showModal();
  }
  let inputTimer: number | undefined;

  function settingsClick(e: MouseEvent) {
    const d = document.getElementById('dlg-settings') as HTMLDialogElement;
    const target = e.target as HTMLElement;
    const tab = target.closest<HTMLElement>('[data-tab-set]')?.dataset.tabSet as Tab | undefined;
    if (tab) {
      openSettings(tab);
      return;
    }
    const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'reset-format') {
      setLayout({ styles: undefined });
      openSettings('format');
    } else if (act === 'headers') openHeaders();
    else if (act === 'mores') openMores();
    else if (act === 'scene-numbers') openSceneNumbers();
    else if (act === 'lock-pages') {
      toggleLockPages();
      openSettings('page');
    }
  }

  /* ------------------------------------------------------------------ */
  /* Production                                                          */
  /* ------------------------------------------------------------------ */

  function openSceneNumbers() {
    const d = dialog('dlg-scene-numbers', false);
    const l = ctx.layout();
    const locked = Boolean(l.sceneNumbersLocked);
    d.innerHTML = `${head(t('m.sceneNumbersDlg'))}
      <div class="grid gap-1">
        ${toggle('sceneNumbers', t('sn.show'), '', settings.sceneNumbers)}
        ${select('sceneNumberSide', t('set.numberSide'), [['left', t('set.left')], ['right', t('set.right')], ['both', t('set.both')]], l.sceneNumberSide ?? 'both')}
        ${select('sceneLetterStyle', t('sn.style'), [['suffix', t('sn.suffix')], ['prefix', t('sn.prefix')]], l.sceneLetterStyle ?? 'suffix', t('sn.styleDesc'))}
      </div>
      <div class="fd-box mt-3">
        <p class="text-sm font-medium">${esc(locked ? t('sn.lockedTitle') : t('sn.unlockedTitle'))}</p>
        <p class="set-desc">${esc(locked ? t('sn.lockedDesc') : t('sn.unlockedDesc'))}</p>
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" class="btn${locked ? '' : ' btn-primary'}" data-act="${locked ? 'unlock' : 'lock'}"><span>${esc(locked ? t('sn.unlock') : t('sn.lock'))}</span></button>
        </div>
      </div>`;
    d.onchange = (e) => {
      const el = e.target as HTMLInputElement | HTMLSelectElement;
      if (el.dataset.k === 'sceneNumbers') controls.sceneNumbers.set((el as HTMLInputElement).checked as never);
      if (el.dataset.k === 'sceneNumberSide') controls.sceneNumberSide.set(el.value as never);
      if (el.dataset.k === 'sceneLetterStyle') setLayout({ sceneLetterStyle: el.value === 'prefix' ? 'prefix' : undefined });
    };
    d.onclick = (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'lock') lockSceneNumbers(true);
      else if (act === 'unlock') {
        if (!confirm(t('sn.unlockConfirm'))) return;
        lockSceneNumbers(false);
      } else return;
      openSceneNumbers();
    };
    if (!d.open) d.showModal();
  }

  function lockSceneNumbers(on: boolean) {
    const blocks = editor.getBlocks();
    const labels = sceneLabels(blocks, ctx.layout());
    const patches = new Map<number, { num?: string }>();
    blocks.forEach((b, i) => {
      if (b.type !== 'scene') return;
      if (on) patches.set(i, { num: labels.get(i) });
      else if (b.num) patches.set(i, { num: undefined });
    });
    editor.updateBlocks(patches);
    setLayout({ sceneNumbersLocked: on });
    ctx.toast(on ? t('sn.lockedToast') : t('sn.unlockedToast'));
  }

  function openHeaders() {
    const d = dialog('dlg-headers');
    const l = ctx.layout();
    const h = l.header ?? DEFAULT_HEADER;
    const f = l.footer ?? DEFAULT_FOOTER;
    const slots = (name: string, v: string[]) =>
      `<div class="hf-slots">${['left', 'center', 'right']
        .map((s, i) => `<label><span>${esc(t(`hf.${s}` as Key))}</span><input class="text-input" name="${name}${i}" placeholder=" " value="${esc(v[i])}" autocomplete="off" spellcheck="false" /></label>`)
        .join('')}</div>`;
    d.innerHTML = `${head(t('m.headersFooters'))}
      <form class="grid gap-3" method="dialog">
        <fieldset class="ex-group"><legend>${esc(t('hf.header'))}</legend>${slots('h', h)}</fieldset>
        <fieldset class="ex-group"><legend>${esc(t('hf.footer'))}</legend>${slots('f', f)}</fieldset>
        <p class="set-desc">${t('hf.tokens')}</p>
        ${toggle('firstPageHeader', t('hf.firstPage'), t('hf.firstPageDesc'), Boolean(l.firstPageHeader))}
        <div class="flex items-center justify-end gap-2 pt-1">
          <button type="button" class="link-btn mr-auto" data-act="reset">${esc(t('fmt.reset'))}</button>
          <button type="button" class="btn" data-close>${esc(t('proj.cancel'))}</button>
          <button type="submit" class="btn btn-primary"><span>${esc(t('btn.save'))}</span></button>
        </div>
      </form>`;
    const form = d.querySelector('form')!;
    d.onclick = (e) => {
      if ((e.target as HTMLElement).closest('[data-act=reset]')) {
        DEFAULT_HEADER.forEach((v, i) => ((form.elements.namedItem(`h${i}`) as HTMLInputElement).value = v));
        DEFAULT_FOOTER.forEach((v, i) => ((form.elements.namedItem(`f${i}`) as HTMLInputElement).value = v));
      }
    };
    d.onchange = null;
    form.onsubmit = () => {
      const get = (n: string) => (form.elements.namedItem(n) as HTMLInputElement).value.slice(0, 120);
      setLayout({
        header: [get('h0'), get('h1'), get('h2')],
        footer: [get('f0'), get('f1'), get('f2')],
        firstPageHeader: (form.querySelector('[data-k=firstPageHeader]') as HTMLInputElement).checked,
      });
      ctx.toast(t('hf.saved'));
    };
    d.showModal();
  }

  function openMores() {
    const d = dialog('dlg-mores', false);
    const l = ctx.layout();
    d.innerHTML = `${head(t('m.moresContds'))}
      <form class="grid gap-1" method="dialog">
        ${toggle('more', t('mc.more'), t('mc.moreDesc'), l.more !== false)}
        <div class="mc-words">
          <label><span>${esc(t('mc.moreWord'))}</span><input class="text-input" name="moreText" placeholder=" " value="${esc(l.moreText ?? 'MORE')}" maxlength="20" /></label>
          <label><span>${esc(t('mc.contdWord'))}</span><input class="text-input" name="contdText" placeholder=" " value="${esc(l.contdText ?? "CONT'D")}" maxlength="20" /></label>
        </div>
        ${toggle('autoContd', t('mc.autoContd'), t('mc.autoContdDesc'), l.autoContd !== false)}
        ${toggle('sceneContinueds', t('mc.sceneContinueds'), t('mc.sceneContinuedsDesc'), Boolean(l.sceneContinueds))}
        <div class="flex justify-end gap-2 pt-3">
          <button type="button" class="btn" data-close>${esc(t('proj.cancel'))}</button>
          <button type="submit" class="btn btn-primary"><span>${esc(t('btn.save'))}</span></button>
        </div>
      </form>`;
    const form = d.querySelector('form')!;
    d.onclick = null;
    d.onchange = null;
    form.onsubmit = () => {
      const on = (k: string) => (form.querySelector(`[data-k=${k}]`) as HTMLInputElement).checked;
      const word = (n: string, def: string) => ((form.elements.namedItem(n) as HTMLInputElement).value.trim().replace(/^\(|\)$/g, '').toUpperCase() || def);
      setLayout({
        more: on('more'),
        autoContd: on('autoContd'),
        sceneContinueds: on('sceneContinueds'),
        moreText: word('moreText', 'MORE'),
        contdText: word('contdText', "CONT'D"),
      });
      ctx.toast(t('mc.saved'));
    };
    d.showModal();
  }

  function openWatermark() {
    const d = dialog('dlg-watermark', false);
    const cur = ctx.layout().watermark ?? '';
    const chips = [t('wm.confidential'), t('wm.draft'), settings.writer].filter(Boolean);
    d.innerHTML = `${head(t('m.watermark'), esc(t('wm.desc')))}
      <form class="grid gap-3" method="dialog">
        <input class="text-input wm-input" name="wm" value="${esc(cur)}" placeholder="${esc(t('wm.placeholder'))}" maxlength="60" autocomplete="off" />
        <div class="flex flex-wrap gap-2">${chips.map((c) => `<button type="button" class="chip" data-wm="${esc(c)}">${esc(c)}</button>`).join('')}</div>
        <div class="flex items-center justify-end gap-2 pt-1">
          ${cur ? `<button type="button" class="link-btn mr-auto" data-act="remove">${esc(t('wm.remove'))}</button>` : ''}
          <button type="button" class="btn" data-close>${esc(t('proj.cancel'))}</button>
          <button type="submit" class="btn btn-primary"><span>${esc(t('btn.save'))}</span></button>
        </div>
      </form>`;
    const form = d.querySelector('form')!;
    const field = form.elements.namedItem('wm') as HTMLInputElement;
    d.onchange = null;
    d.onclick = (e) => {
      const target = e.target as HTMLElement;
      const chip = target.closest<HTMLElement>('[data-wm]');
      if (chip) field.value = chip.dataset.wm!;
      if (target.closest('[data-act=remove]')) {
        setLayout({ watermark: undefined });
        d.close();
        ctx.toast(t('wm.removed'));
      }
    };
    form.onsubmit = () => {
      setLayout({ watermark: field.value.trim() || undefined });
      ctx.toast(field.value.trim() ? t('wm.saved') : t('wm.removed'));
    };
    d.showModal();
    field.focus();
  }

  function toggleLockPages() {
    const blocks = editor.getBlocks();
    if (ctx.layout().pagesLocked) {
      if (!confirm(t('lp.unlockConfirm'))) return;
      const patches = new Map<number, { pg?: string }>();
      blocks.forEach((b, i) => b.pg && patches.set(i, { pg: undefined }));
      editor.updateBlocks(patches);
      setLayout({ pagesLocked: false });
      ctx.toast(t('lp.unlocked'));
      return;
    }
    const anchors = pageAnchors(blocks, layoutOptions(blocks));
    const patches = new Map<number, { pg?: string; pgLine?: number }>();
    blocks.forEach((b, i) => b.pg && patches.set(i, { pg: undefined }));
    for (const a of anchors) patches.set(a.block, { pg: a.label, pgLine: a.line });
    editor.updateBlocks(patches);
    setLayout({ pagesLocked: true });
    ctx.toast(t(anchors.length === 1 ? 'lp.locked1' : 'lp.locked', { n: anchors.length }));
  }

  function toggleSeparateScene() {
    const s = currentScene();
    if (s === null) return ctx.toast(t('prod.noScene'));
    const b = editor.getBlocks()[s];
    editor.updateBlock(s, { newPage: !b.newPage });
    ctx.toast(b.newPage ? t('prod.separateOff') : t('prod.separateOn'));
  }

  function toggleOmitScene() {
    const s = currentScene();
    if (s === null) return ctx.toast(t('prod.noScene'));
    const blocks = editor.getBlocks();
    const head = blocks[s];
    if (head.omit?.length) {
      // Bring the scene back exactly as it was.
      const restored = head.omit.map((b) => ({ ...b }));
      if (head.num && restored[0]?.type === 'scene') restored[0].num = head.num;
      editor.replaceBlocks([...blocks.slice(0, s), ...restored, ...blocks.slice(s + 1)]);
      ctx.toast(t('prod.restored'));
      return;
    }
    let end = s + 1;
    while (end < blocks.length && !['scene', 'act', 'endact', 'section'].includes(blocks[end].type)) end++;
    const labels = sceneLabels(blocks, ctx.layout());
    const omitted: Block = {
      type: 'scene',
      text: 'OMITTED',
      omit: blocks.slice(s, end).map((b) => {
        const { omit: _o, ...rest } = b;
        return rest;
      }),
      ...(ctx.layout().sceneNumbersLocked ? { num: head.num ?? labels.get(s) } : {}),
      ...(head.color ? { color: head.color } : {}),
    };
    editor.replaceBlocks([...blocks.slice(0, s), omitted, ...blocks.slice(end)]);
    ctx.toast(t('prod.omitted'));
  }

  /* ------------------------------------------------------------------ */
  /* Revisions                                                           */
  /* ------------------------------------------------------------------ */

  function ensureRevision(): Revision {
    return ctx.revision() ?? { color: 'blue', date: today(ctx.locale()) };
  }

  function toggleTracking() {
    const rev = ctx.revision();
    if (rev?.baseline) {
      if (!confirm(t('rev.stopConfirm'))) return;
      const { baseline: _b, ...rest } = rev;
      ctx.setRevision(rest);
      ctx.toast(t('rev.stopped'));
    } else {
      editor.flush();
      ctx.setRevision({ ...ensureRevision(), baseline: toLines(editor.getBlocks()) });
      if (!settings.showRevisions) {
        settings.showRevisions = true;
        ctx.applySettings();
      }
      ctx.toast(t('rev.started', { color: t(`rev.${ensureRevision().color}` as Key) }));
    }
    revCache = null;
    refreshScreen();
    ctx.applySettings();
  }

  function selectedRange(): [number, number] {
    const sel = editor.selection();
    const i = editor.currentIndex();
    if (sel) return [sel.start.b, sel.end.b];
    return [Math.max(0, i), Math.max(0, i)];
  }

  function markChange(on: boolean) {
    const [a, b] = selectedRange();
    const blocks = editor.getBlocks();
    const patches = new Map<number, { mark?: boolean }>();
    for (let i = a; i <= b; i++) if (Boolean(blocks[i]?.mark) !== on) patches.set(i, { mark: on });
    if (patches.size) editor.updateBlocks(patches);
    if (!on) {
      // Unmark also accepts tracked changes in the selection.
      const rev = ctx.revision();
      if (rev?.baseline) {
        let baseline: Line[] = rev.baseline;
        const now = editor.getBlocks();
        const hunks = diffLines(baseline, toLines(now)).filter((h) => h.bEnd > a && h.bStart <= b + (h.bStart === h.bEnd ? 1 : 0));
        for (const h of [...hunks].reverse()) baseline = acceptHunk(baseline, now, h);
        if (hunks.length) ctx.setRevision({ ...rev, baseline });
      }
    }
    revCache = null;
    refreshScreen();
    ctx.applySettings();
    ctx.toast(on ? t('rev.marked') : t('rev.unmarked'));
  }

  const lineHtml = (l: { type: ElType; text: string }) =>
    `<span class="rv-type">${esc(LABELS[l.type])}</span><span class="rv-text">${esc(l.text) || '<em>—</em>'}</span>`;

  function hunkHtml(h: Hunk, base: Line[], blocks: Block[], actions: boolean, pageOf?: Map<number, number>, labels?: string[]) {
    const del = base.slice(h.aStart, h.aEnd);
    const add = blocks.slice(h.bStart, h.bEnd);
    const where = pageOf && labels ? labels[pageOf.get(h.bStart) ?? pageOf.get(h.bStart - 1) ?? 0] : '';
    return `<li class="rv-hunk">
      <div class="rv-meta">${where ? `<span class="pill">${esc(t('rev.page', { n: where }))}</span>` : ''}
        ${actions ? `<span class="rv-acts">
          <button type="button" class="icon-btn" data-go="${h.bStart}" title="${esc(t('rev.goto'))}" aria-label="${esc(t('rev.goto'))}">${ICON.go}</button>
          <button type="button" class="icon-btn ok" data-accept="${h.aStart}:${h.bStart}" title="${esc(t('rev.accept'))}" aria-label="${esc(t('rev.accept'))}">${ICON.check}</button>
          <button type="button" class="icon-btn no" data-reject="${h.aStart}:${h.bStart}" title="${esc(t('rev.reject'))}" aria-label="${esc(t('rev.reject'))}">${ICON.undo}</button>
        </span>` : ''}</div>
      ${del.map((l) => `<div class="rv-line rv-del">${lineHtml(l)}</div>`).join('')}
      ${add.map((b) => `<div class="rv-line rv-add">${lineHtml(b)}</div>`).join('')}
    </li>`;
  }

  function openAcceptReject() {
    editor.flush();
    const d = dialog('dlg-accept');
    const render = () => {
      const rev = ctx.revision();
      const blocks = editor.getBlocks();
      const marks = blocks.filter((b) => b.mark).length;
      if (!rev?.baseline) {
        d.innerHTML = `${head(t('m.acceptReject'))}
          <div class="fd-empty"><p>${esc(t('rev.notTracking'))}</p>
          <button type="button" class="btn btn-primary" data-act="track"><span>${esc(t('rev.startTracking'))}</span></button></div>
          ${marks ? `<p class="set-desc mt-3">${esc(t('rev.manualMarks', { n: marks }))} <button type="button" class="link-btn" data-act="clear-marks">${esc(t('rev.clearMarks'))}</button></p>` : ''}`;
        return;
      }
      const hunks = diffLines(rev.baseline, toLines(blocks));
      const laid = ctx.lastLayout();
      const pageOf = blockPages(laid);
      const labels = laid.map((p) => p.label);
      d.innerHTML = `${head(t('m.acceptReject'), esc(t('rev.summary', { n: hunks.length, color: t(`rev.${rev.color}` as Key) })))}
        ${hunks.length ? `<ol class="rv-list">${hunks.map((h) => hunkHtml(h, rev.baseline!, blocks, true, pageOf, labels)).join('')}</ol>` : `<div class="fd-empty"><p>${esc(t('rev.noChanges'))}</p></div>`}
        ${marks ? `<p class="set-desc mt-2">${esc(t('rev.manualMarks', { n: marks }))} <button type="button" class="link-btn" data-act="clear-marks">${esc(t('rev.clearMarks'))}</button></p>` : ''}
        <div class="flex flex-wrap items-center justify-end gap-2 pt-3">
          ${hunks.length ? `<button type="button" class="btn mr-auto" data-act="reject-all">${esc(t('rev.rejectAll'))}</button>
          <button type="button" class="btn btn-primary" data-act="accept-all"><span>${esc(t('rev.acceptAll'))}</span></button>` : `<button type="button" class="btn" data-close>${esc(t('btn.close'))}</button>`}
        </div>`;
    };
    const findHunk = (spec: string) => {
      const [a, b] = spec.split(':').map(Number);
      const rev = ctx.revision()!;
      return diffLines(rev.baseline!, toLines(editor.getBlocks())).find((h) => h.aStart === a && h.bStart === b);
    };
    d.onchange = null;
    d.onclick = (e) => {
      const target = e.target as HTMLElement;
      const go = target.closest<HTMLElement>('[data-go]');
      const acc = target.closest<HTMLElement>('[data-accept]');
      const rej = target.closest<HTMLElement>('[data-reject]');
      const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
      const rev = ctx.revision();
      if (go) {
        d.close();
        editor.focus(Math.min(Number(go.dataset.go), editorEl.children.length - 1));
        return;
      }
      if (acc && rev?.baseline) {
        const h = findHunk(acc.dataset.accept!);
        if (h) ctx.setRevision({ ...rev, baseline: acceptHunk(rev.baseline, editor.getBlocks(), h) });
      } else if (rej && rev?.baseline) {
        const h = findHunk(rej.dataset.reject!);
        if (h) editor.replaceBlocks(rejectHunk(rev.baseline, editor.getBlocks(), h));
      } else if (act === 'accept-all' && rev?.baseline) {
        ctx.setRevision({ ...rev, baseline: toLines(editor.getBlocks()) });
        ctx.toast(t('rev.acceptedAll'));
      } else if (act === 'reject-all' && rev?.baseline) {
        if (!confirm(t('rev.rejectAllConfirm'))) return;
        let blocks = editor.getBlocks();
        for (const h of diffLines(rev.baseline, toLines(blocks)).reverse()) blocks = rejectHunk(rev.baseline, blocks, h);
        editor.replaceBlocks(blocks);
        ctx.toast(t('rev.rejectedAll'));
      } else if (act === 'track') {
        toggleTracking();
      } else if (act === 'clear-marks') {
        const patches = new Map<number, { mark?: boolean }>();
        editor.getBlocks().forEach((b, i) => b.mark && patches.set(i, { mark: false }));
        editor.updateBlocks(patches);
      } else return;
      revCache = null;
      refreshScreen();
      render();
    };
    render();
    if (!d.open) d.showModal();
  }

  function openDateWriters() {
    const d = dialog('dlg-revinfo', false);
    const rev = ensureRevision();
    d.innerHTML = `${head(t('m.dateWriters'), esc(t('rev.infoDesc')))}
      <form class="grid gap-3" method="dialog">
        <fieldset class="ex-group"><legend>${esc(t('rev.color'))}</legend>
          <div class="rev-swatches">${REV_COLORS.map(
            (c) => `<label class="rev-swatch" style="--sw:${REV_HEX[c]}"><input type="radio" name="color" value="${c}"${c === rev.color ? ' checked' : ''} /><i></i><span>${esc(t(`rev.${c}` as Key))}</span></label>`,
          ).join('')}</div>
        </fieldset>
        <label><span>${esc(t('rev.date'))}</span><input class="text-input" name="date" value="${esc(rev.date)}" placeholder="${esc(today(ctx.locale()))}" maxlength="40" /></label>
        <label><span>${esc(t('set.writer'))}</span><input class="text-input" name="writer" value="${esc(settings.writer)}" placeholder="${esc(t('set.writerPh'))}" maxlength="80" /></label>
        <p class="set-desc">${esc(t('rev.preview'))}: <b class="rev-preview"></b></p>
        <div class="flex items-center justify-end gap-2 pt-1">
          <button type="button" class="link-btn mr-auto" data-act="next">${esc(t('rev.nextColor'))}</button>
          <button type="button" class="btn" data-close>${esc(t('proj.cancel'))}</button>
          <button type="submit" class="btn btn-primary"><span>${esc(t('btn.save'))}</span></button>
        </div>
      </form>`;
    const form = d.querySelector('form')!;
    const val = () => ({
      color: ((new FormData(form).get('color') as string) || 'blue') as RevColor,
      date: (form.elements.namedItem('date') as HTMLInputElement).value.trim(),
    });
    const preview = () => {
      const v = val();
      const el = d.querySelector<HTMLElement>('.rev-preview')!;
      el.textContent = `${t(`rev.${v.color}` as Key)} ${t('rev.rev')} ${v.date || today(ctx.locale())}`;
      el.style.color = REV_HEX[v.color];
    };
    preview();
    d.onchange = preview;
    d.oninput = preview;
    d.onclick = (e) => {
      if (!(e.target as HTMLElement).closest('[data-act=next]')) return;
      const k = REV_COLORS.indexOf(val().color);
      const next = REV_COLORS[(k + 1) % REV_COLORS.length];
      (form.querySelector(`input[value=${next}]`) as HTMLInputElement).checked = true;
      (form.elements.namedItem('date') as HTMLInputElement).value = today(ctx.locale());
      preview();
    };
    form.onsubmit = () => {
      const v = val();
      ctx.setRevision({ ...(ctx.revision() ?? {}), color: v.color, date: v.date || today(ctx.locale()) });
      settings.writer = (form.elements.namedItem('writer') as HTMLInputElement).value.trim();
      ctx.applySettings();
      refreshScreen();
      ctx.toast(t('rev.infoSaved'));
    };
    d.showModal();
  }

  async function openLineHistory() {
    editor.flush();
    const i = editor.currentIndex();
    const blocks = editor.getBlocks();
    const cur = blocks[i];
    if (!cur) return ctx.toast(t('hist.noLine'));
    const d = dialog('dlg-line-history');
    d.innerHTML = `${head(t('m.lineHistory'))}<div class="fd-empty"><p>${esc(t('ui.loading'))}</p></div>`;
    d.onclick = null;
    d.onchange = null;
    d.showModal();
    const snaps = ctx.projectId ? await listSnapshots(ctx.projectId).catch(() => [] as Snapshot[]) : [];
    const versions: { at: number | null; who: string; text: string; type: ElType }[] = [];
    let last = cur.text;
    const add = (old: Line[], at: number | null, who: string) => {
      const k = counterpart(old, blocks, i);
      const text = k === null ? null : old[k];
      if (!text) return false;
      if (text.text !== last) {
        versions.push({ at, who, text: text.text, type: text.type });
        last = text.text;
      }
      return true;
    };
    const rev = ctx.revision();
    if (rev?.baseline) add(rev.baseline, null, t('hist.baseline'));
    for (const s of snaps) if (!add(toLines(s.doc.blocks), s.at, s.label || (s.auto ? t('snap.auto') : '')) ) break;
    const firstSeen = snaps.length ? snaps.findLast((s) => counterpart(toLines(s.doc.blocks), blocks, i) !== null) : undefined;
    d.innerHTML = `${head(t('m.lineHistory'), esc(LABELS[cur.type]))}
      <div class="hist-now"><span class="pill">${esc(t('hist.now'))}</span><div class="rv-line">${lineHtml(cur)}</div></div>
      ${versions.length
        ? `<ol class="hist-list">${versions
            .map(
              (v, k) => `<li><div class="hist-meta"><span>${esc(v.at ? ctx.relTime(v.at) : t('hist.baseline'))}</span>${v.who && v.at ? `<span class="text-muted">· ${esc(v.who)}</span>` : ''}
                <button type="button" class="link-btn ml-auto" data-restore="${k}">${esc(t('hist.restore'))}</button></div>
                <div class="rv-line rv-old">${lineHtml(v)}</div></li>`,
            )
            .join('')}</ol>`
        : `<div class="fd-empty"><p>${esc(snaps.length || rev?.baseline ? t('hist.unchanged') : t('hist.noSnapshots'))}</p></div>`}
      ${firstSeen ? `<p class="set-desc mt-2">${esc(t('hist.since', { time: ctx.relTime(firstSeen.at) }))}</p>` : ''}
      <p class="set-desc mt-1">${esc(t('hist.how'))}</p>`;
    d.onclick = (e) => {
      const r = (e.target as HTMLElement).closest<HTMLElement>('[data-restore]');
      if (!r) return;
      const v = versions[Number(r.dataset.restore)];
      editor.updateBlock(i, { text: v.text, fmt: undefined });
      d.close();
      ctx.toast(t('hist.restored'));
    };
  }

  /* Snapshots & timeline */

  async function takeSnapshot(label: string, auto = false) {
    if (!ctx.projectId) return null;
    await ctx.saveNow();
    return saveSnapshot(ctx.projectId, ctx.currentDoc(), { label, auto, writer: settings.writer });
  }

  function openSaveSnapshot() {
    const d = dialog('dlg-snap-save', false);
    d.innerHTML = `${head(t('m.saveSnapshot'), esc(t('snap.saveDesc')))}
      <form class="grid gap-3" method="dialog">
        <label><span>${esc(t('snap.label'))}</span><input class="text-input" name="label" placeholder="${esc(t('snap.labelPh'))}" maxlength="120" autocomplete="off" /></label>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn" data-close>${esc(t('proj.cancel'))}</button>
          <button type="submit" class="btn btn-primary"><span>${esc(t('m.saveSnapshot'))}</span></button>
        </div>
      </form>`;
    const form = d.querySelector('form')!;
    d.onclick = null;
    d.onchange = null;
    form.onsubmit = async () => {
      const label = (form.elements.namedItem('label') as HTMLInputElement).value.trim() || t('snap.defaultLabel', { date: new Date().toLocaleString(ctx.locale()) });
      try {
        await takeSnapshot(label);
        ctx.toast(t('snap.saved'));
      } catch {
        ctx.toast(t('proj.storageError'));
      }
    };
    d.showModal();
    (form.elements.namedItem('label') as HTMLInputElement).focus();
  }

  function timelineSvg(snaps: Snapshot[], currentWords: number): string {
    const pts = [...snaps].reverse().map((s) => ({ at: s.at, w: s.words, id: s.id, auto: s.auto }));
    pts.push({ at: Date.now(), w: currentWords, id: 'now', auto: false });
    if (pts.length < 2) return '';
    const W = 620;
    const H = 120;
    const pad = 14;
    const t0 = pts[0].at;
    const t1 = pts[pts.length - 1].at;
    const maxW = Math.max(1, ...pts.map((p) => p.w));
    // Even spacing reads better than real time when snapshots cluster.
    const x = (k: number) => pad + (k / (pts.length - 1)) * (W - pad * 2);
    const y = (w: number) => H - pad - (w / maxW) * (H - pad * 2);
    const path = pts.map((p, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)},${y(p.w).toFixed(1)}`).join(' ');
    const area = `${path} L${x(pts.length - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`;
    return `<svg class="tl-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('tl.chartLabel'))}">
      <path d="${area}" class="tl-area"/><path d="${path}" class="tl-line"/>
      ${pts
        .map(
          (p, k) =>
            `<circle cx="${x(k).toFixed(1)}" cy="${y(p.w).toFixed(1)}" r="${p.id === 'now' ? 5 : 4}" class="tl-dot${p.id === 'now' ? ' now' : p.auto ? ' auto' : ''}" data-snap="${p.id}"><title>${esc(p.id === 'now' ? t('hist.now') : new Date(p.at).toLocaleString(ctx.locale()))} — ${p.w.toLocaleString(ctx.locale())} ${esc(t('tl.words'))}</title></circle>`,
        )
        .join('')}
      <text x="${pad}" y="${H - 1}" class="tl-axis">${esc(new Date(t0).toLocaleDateString(ctx.locale()))}</text>
      <text x="${W - pad}" y="${H - 1}" class="tl-axis" text-anchor="end">${esc(new Date(t1).toLocaleDateString(ctx.locale()))}</text>
    </svg>`;
  }

  async function openTimeline(focusList = false) {
    if (!ctx.projectId) return;
    editor.flush();
    const d = dialog('dlg-timeline');
    d.classList.add('dialog-xl');
    let snaps: Snapshot[] = [];
    let comparing: Snapshot | null = null;
    const load = async () => {
      snaps = await listSnapshots(ctx.projectId!).catch(() => []);
    };
    const render = () => {
      const blocks = editor.getBlocks();
      const words = blocks.filter((b) => b.type !== 'note').reduce((s, b) => s + (b.text.trim().match(/\S+/g)?.length ?? 0), 0);
      if (comparing) {
        const base = toLines(comparing.doc.blocks);
        const hunks = diffLines(base, toLines(blocks));
        d.innerHTML = `${head(t('tl.compareTitle'), esc(`${new Date(comparing.at).toLocaleString(ctx.locale())}${comparing.label ? ` — ${comparing.label}` : ''} → ${t('hist.now')}`))}
          <p class="set-desc mb-2">${esc(t('tl.compareSummary', { n: hunks.length }))}</p>
          ${hunks.length ? `<ol class="rv-list">${hunks.map((h) => hunkHtml(h, base, blocks, false)).join('')}</ol>` : `<div class="fd-empty"><p>${esc(t('rev.noChanges'))}</p></div>`}
          <div class="flex justify-between gap-2 pt-3">
            <button type="button" class="btn" data-act="back">← ${esc(t('tl.back'))}</button>
            <button type="button" class="btn btn-primary" data-restore-snap="${comparing.id}"><span>${esc(t('tl.restore'))}</span></button>
          </div>`;
        return;
      }
      const delta = (s: Snapshot) => {
        const n = words - s.words;
        return n === 0 ? '±0' : n > 0 ? `+${n.toLocaleString(ctx.locale())}` : n.toLocaleString(ctx.locale());
      };
      d.innerHTML = `${head(t('m.timeline'), esc(t('tl.desc')))}
        ${snaps.length ? timelineSvg(snaps, words) : ''}
        <div class="flex items-center justify-between gap-2 mt-2 mb-2">
          <h3 class="font-semibold text-sm">${esc(t('m.snapshots').replace(/…$/, ''))} <span class="pill">${snaps.length}</span></h3>
          <button type="button" class="btn btn-primary btn-sm" data-act="save"><span>${esc(t('m.saveSnapshot'))}</span></button>
        </div>
        ${snaps.length
          ? `<ul class="snap-list">${snaps
              .map(
                (s) => `<li class="snap-row" data-id="${s.id}">
                  <span class="snap-dot${s.auto ? ' auto' : ''}" aria-hidden="true"></span>
                  <div class="min-w-0 flex-1">
                    <div class="snap-title">${esc(s.label || (s.auto ? t('snap.auto') : t('snap.untitled')))}</div>
                    <div class="snap-meta">${esc(new Date(s.at).toLocaleString(ctx.locale()))} · ${esc(ctx.relTime(s.at))}${s.writer ? ` · ${esc(s.writer)}` : ''} · ${esc(t('tl.pages', { n: s.pages }))} · ${esc(s.words.toLocaleString(ctx.locale()))} ${esc(t('tl.words'))} <span class="snap-delta">(${esc(t('tl.sinceThen', { d: delta(s) }))})</span></div>
                  </div>
                  <div class="snap-acts">
                    <button type="button" class="icon-btn" data-compare="${s.id}" title="${esc(t('tl.compare'))}" aria-label="${esc(t('tl.compare'))}">${ICON.compare}</button>
                    <button type="button" class="icon-btn" data-rename-snap="${s.id}" title="${esc(t('tl.rename'))}" aria-label="${esc(t('tl.rename'))}">${ICON.edit}</button>
                    <button type="button" class="icon-btn" data-copy-snap="${s.id}" title="${esc(t('tl.openCopy'))}" aria-label="${esc(t('tl.openCopy'))}">${ICON.copy}</button>
                    <button type="button" class="icon-btn" data-restore-snap="${s.id}" title="${esc(t('tl.restore'))}" aria-label="${esc(t('tl.restore'))}">${ICON.undo}</button>
                    <button type="button" class="icon-btn no" data-del-snap="${s.id}" title="${esc(t('tl.delete'))}" aria-label="${esc(t('tl.delete'))}">${ICON.trash}</button>
                  </div>
                </li>`,
              )
              .join('')}</ul>`
          : `<div class="fd-empty"><p>${esc(t('tl.empty'))}</p></div>`}
        <p class="set-desc mt-2">${esc(settings.autoSnapshots ? t('tl.autoOn') : t('tl.autoOff'))}</p>`;
      if (focusList) d.querySelector<HTMLElement>('.snap-list button')?.focus();
    };
    d.onchange = null;
    d.oninput = null;
    d.onclick = async (e) => {
      const target = e.target as HTMLElement;
      const find = (attr: string) => {
        const el = target.closest<HTMLElement>(`[${attr}]`);
        return el ? snaps.find((s) => s.id === el.getAttribute(attr)) : undefined;
      };
      const dot = target.closest<SVGElement>('[data-snap]');
      if (dot && dot.dataset.snap !== 'now') {
        d.querySelector(`.snap-row[data-id="${dot.dataset.snap}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        d.querySelector(`.snap-row[data-id="${dot.dataset.snap}"]`)?.classList.add('flash');
        return;
      }
      const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'back') {
        comparing = null;
        render();
        return;
      }
      if (act === 'save') {
        await takeSnapshot(t('snap.defaultLabel', { date: new Date().toLocaleString(ctx.locale()) }));
        ctx.toast(t('snap.saved'));
        await load();
        render();
        return;
      }
      let s: Snapshot | undefined;
      if ((s = find('data-compare'))) {
        comparing = s;
        render();
      } else if ((s = find('data-rename-snap'))) {
        const label = prompt(t('tl.renamePrompt'), s.label);
        if (label === null) return;
        await renameSnapshot(s.id, label);
        await load();
        render();
      } else if ((s = find('data-del-snap'))) {
        if (!confirm(t('tl.deleteConfirm'))) return;
        await deleteSnapshot(s.id);
        await load();
        render();
      } else if ((s = find('data-copy-snap'))) {
        const doc = structuredClone(s.doc);
        doc.titlePage.title = `${doc.titlePage.title || t('file.default')} (${new Date(s.at).toLocaleDateString(ctx.locale())})`;
        const id = await createProject(doc);
        ctx.toast(t('tl.copied'));
        window.open(editorUrl(id), '_blank', 'noopener');
      } else if ((s = find('data-restore-snap'))) {
        if (!confirm(t('tl.restoreConfirm'))) return;
        // Keep what we have now as a snapshot first, so a restore can be undone later too.
        await takeSnapshot(t('tl.beforeRestore'), true);
        editor.replaceBlocks(structuredClone(s.doc.blocks));
        ctx.setTitlePage({ ...s.doc.titlePage });
        d.close();
        ctx.toast(t('tl.restored'));
      }
    };
    d.innerHTML = `${head(t('m.timeline'))}<div class="fd-empty"><p>${esc(t('ui.loading'))}</p></div>`;
    if (!d.open) d.showModal();
    await load();
    render();
  }

  async function duplicateDoc() {
    if (!ctx.projectId) return;
    await ctx.saveNow();
    const id = await duplicateProject(ctx.projectId, (title) => t('proj.copy', { name: title || t('file.default') }));
    if (!id) return;
    ctx.toast(t('dup.done'));
    location.href = editorUrl(id);
  }

  let lastAuto = 0;
  /** Automatic snapshot at most every 30 minutes while writing. */
  async function maybeAutoSnapshot() {
    if (!settings.autoSnapshots || !ctx.projectId) return;
    const now = Date.now();
    if (now - lastAuto < 30 * 60 * 1000) return;
    lastAuto = now;
    try {
      const snaps = await listSnapshots(ctx.projectId);
      const newest = snaps[0];
      const doc = ctx.currentDoc();
      if (newest && now - newest.at < 30 * 60 * 1000) return;
      if (newest && JSON.stringify(newest.doc.blocks) === JSON.stringify(doc.blocks)) return;
      if (!doc.blocks.some((b) => b.text.trim())) return;
      await saveSnapshot(ctx.projectId, doc, { auto: true, writer: settings.writer });
    } catch {
      /* best effort */
    }
  }

  /* ------------------------------------------------------------------ */
  /* Tagger (side panel tab)                                             */
  /* ------------------------------------------------------------------ */

  const tagPanel = document.getElementById('tag-panel')!;
  let lastSelection: { b: number; s: number; e: number; text: string } | null = null;
  document.addEventListener('selectionchange', () => {
    const sel = editor.selection();
    if (!sel || sel.collapsed || sel.start.b !== sel.end.b) {
      if (sel && sel.collapsed) lastSelection = null;
      updateTagButton();
      return;
    }
    const text = editor.getBlocks()[sel.start.b]?.text.slice(sel.start.o, sel.end.o).replace(/\s+/g, ' ').trim() ?? '';
    lastSelection = text ? { b: sel.start.b, s: sel.start.o, e: sel.end.o, text } : null;
    updateTagButton();
  });

  function updateTagButton() {
    const hint = tagPanel.querySelector<HTMLElement>('.tag-hint');
    if (!hint) return;
    hint.innerHTML = lastSelection
      ? `${esc(t('tag.tagAs'))} <b>“${esc(lastSelection.text.slice(0, 40))}”</b>`
      : esc(t('tag.selectFirst'));
    tagPanel.classList.toggle('has-selection', Boolean(lastSelection));
  }

  function renderTags() {
    const tags = ctx.tags();
    const blocks = editor.getBlocks();
    const scenes = breakdown(blocks, tags, ctx.layout());
    const counts = tagSceneCounts(scenes);
    const cast = untaggedCast(blocks, tags);
    const groups = TAG_CATS.filter((c) => tags.some((tg) => tg.cat === c))
      .map((c) => {
        const items = tags.filter((tg) => tg.cat === c).sort((a, b) => a.text.localeCompare(b.text));
        return `<li class="tag-group" style="--tag:${TAG_HEX[c]}"><div class="tag-group-head"><i class="tag-swatch"></i>${esc(catLabel(c))}<span class="pill">${items.length}</span></div>
          <div class="tag-items">${items
            .map(
              (tg) => `<span class="tag-item"><button type="button" class="tag-find" data-find="${esc(tg.text)}" title="${esc(t('tag.findNext'))}">${esc(tg.text)}<span class="tag-n">${counts.get(tg.text) ?? 0}</span></button><button type="button" class="tag-del" data-untag="${esc(c)}|${esc(tg.text)}" aria-label="${esc(t('tag.remove', { text: tg.text }))}">${ICON.x}</button></span>`,
            )
            .join('')}</div></li>`;
      })
      .join('');
    tagPanel.innerHTML = `<div class="tag-top">
        <p class="tag-hint"></p>
        <div class="tag-cats">${TAG_CATS.map((c) => `<button type="button" class="tag-cat" style="--tag:${TAG_HEX[c]}" data-cat="${c}"><i class="tag-swatch"></i>${esc(catLabel(c))}</button>`).join('')}</div>
        ${cast.length ? `<button type="button" class="link-btn" data-act="cast">${esc(t('tag.addCast', { n: cast.length }))}</button>` : ''}
      </div>
      ${tags.length ? `<ul class="tag-groups">${groups}</ul>` : `<p class="nav-empty">${esc(t('tag.empty'))}</p>`}
      <div class="tag-foot">
        <label class="tag-show">${switchHtml('data-act="show"', settings.showTags, true)} ${esc(t('set.showTags'))}</label>
        ${tags.length ? `<button type="button" class="btn btn-sm" data-act="csv">${esc(t('tag.csv'))}</button>` : ''}
      </div>`;
    updateTagButton();
  }

  tagPanel.addEventListener('mousedown', (e) => {
    // Keep the script selection when clicking a category.
    if ((e.target as HTMLElement).closest('button')) e.preventDefault();
  });
  tagPanel.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const cat = target.closest<HTMLElement>('[data-cat]')?.dataset.cat as TagCat | undefined;
    const find = target.closest<HTMLElement>('[data-find]')?.dataset.find;
    const untag = target.closest<HTMLElement>('[data-untag]')?.dataset.untag;
    const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
    const tags = ctx.tags();
    if (cat) {
      if (!lastSelection) return ctx.toast(t('tag.selectFirst'));
      const text = lastSelection.text.slice(0, 120);
      const rest = tags.filter((tg) => tg.text.toLowerCase() !== text.toLowerCase());
      ctx.setTags([...rest, { text, cat }]);
      if (!settings.showTags) {
        settings.showTags = true;
        ctx.applySettings();
      }
      ctx.toast(t('tag.added', { text, cat: catLabel(cat) }));
    } else if (find) {
      findNext(find);
      return;
    } else if (untag) {
      const [c, text] = [untag.slice(0, untag.indexOf('|')), untag.slice(untag.indexOf('|') + 1)];
      ctx.setTags(tags.filter((tg) => !(tg.cat === c && tg.text === text)));
    } else if (act === 'cast') {
      ctx.setTags([...tags, ...untaggedCast(editor.getBlocks(), tags).map((text) => ({ text, cat: 'cast' as TagCat }))]);
    } else if (act === 'csv') {
      const scenes = breakdown(editor.getBlocks(), tags, ctx.layout());
      ctx.download(`${ctx.fileBase()}-breakdown.csv`, breakdownCsv(scenes, tags), 'text/csv');
      return;
    } else if (act === 'show') {
      settings.showTags = (target as HTMLInputElement).checked;
      ctx.applySettings();
    } else return;
    refreshScreen();
    renderTags();
  });

  let findFrom = { b: -1, o: 0 };
  function findNext(text: string) {
    const blocks = editor.getBlocks();
    const re = tagRegex(text);
    const n = blocks.length;
    const start = editor.currentIndex() === findFrom.b ? findFrom : { b: Math.max(0, editor.currentIndex()), o: 0 };
    for (let k = 0; k <= n; k++) {
      const i = (start.b + k) % n;
      re.lastIndex = k === 0 ? start.o : 0;
      const m = re.exec(blocks[i].text);
      if (m) {
        editor.focus(i, m.index);
        editor.restoreCaret({ b: i, o: m.index, end: { b: i, o: m.index + m[0].length } });
        findFrom = { b: i, o: m.index + m[0].length };
        return;
      }
    }
    ctx.toast(t('tag.notFound'));
  }

  function openTagger() {
    ctx.showSidebar();
    ctx.setSidebarTab('tags');
    renderTags();
  }

  /* ------------------------------------------------------------------ */
  /* Shorten document                                                    */
  /* ------------------------------------------------------------------ */

  function openShorten() {
    editor.flush();
    const d = dialog('dlg-shorten');
    const render = (max: number) => {
      const blocks = editor.getBlocks();
      const spots = findTightSpots(blocks, max);
      const laid = ctx.lastLayout();
      const pageOf = blockPages(laid);
      const lpp = laid[0] ? Math.max(1, laid[0].rows.length) : 54;
      d.innerHTML = `${head(t('m.shorten'), esc(t('sh.desc')))}
        <div class="sh-summary">
          <div><b>${spots.length}</b><span>${esc(t('sh.spots'))}</span></div>
          <div><b>${spots.length}</b><span>${esc(t('sh.lines'))}</span></div>
          <div><b>≈ ${(spots.length / lpp).toFixed(1)}</b><span>${esc(t('sh.pages'))}</span></div>
          <label class="sh-max"><span>${esc(t('sh.max'))}</span><select class="text-input" data-max>${[6, 9, 12, 16, 20]
            .map((n) => `<option value="${n}"${n === max ? ' selected' : ''}>${n}</option>`)
            .join('')}</select></label>
        </div>
        ${spots.length
          ? `<ol class="sh-list">${spots
              .map((s) => {
                const b = blocks[s.block];
                const before = b.text.slice(Math.max(0, s.from - 60), s.from);
                const tail = b.text.slice(s.from).trimEnd();
                return `<li><button type="button" class="sh-item" data-spot="${s.block}:${s.from}:${s.from + tail.length}">
                  <span class="sh-where"><span class="pill">${esc(t('rev.page', { n: laid[pageOf.get(s.block) ?? 0]?.label ?? '1' }))}</span><span class="rv-type">${esc(LABELS[b.type])}</span></span>
                  <span class="sh-text">${s.from > 60 ? '…' : ''}${esc(before)}<mark>${esc(tail)}</mark></span>
                  <span class="sh-chars">${esc(t('sh.chars', { n: s.chars }))}</span></button></li>`;
              })
              .join('')}</ol>`
          : `<div class="fd-empty"><p>${esc(t('sh.none'))}</p></div>`}
        <p class="set-desc mt-2">${esc(t('sh.how'))}</p>`;
    };
    d.onchange = (e) => {
      const el = e.target as HTMLSelectElement;
      if (el.dataset.max !== undefined) render(Number(el.value));
    };
    d.onclick = (e) => {
      const spot = (e.target as HTMLElement).closest<HTMLElement>('[data-spot]')?.dataset.spot;
      if (!spot) return;
      const [b, s, end] = spot.split(':').map(Number);
      d.close();
      editor.focus(b, s);
      editor.restoreCaret({ b, o: s, end: { b, o: end } });
    };
    render(12);
    if (!d.open) d.showModal();
  }

  /* ------------------------------------------------------------------ */
  /* Read aloud                                                          */
  /* ------------------------------------------------------------------ */

  const raBar = document.getElementById('ra-bar')!;
  const reader = createReader({
    bar: raBar,
    getBlocks: () => editor.getBlocks(),
    startIndex: () => Math.max(0, editor.currentIndex()),
    blockEl: (i) => editorEl.children[i] as HTMLElement | undefined,
    lang: () => settings.docLang,
    onVoices: openVoices,
  });

  function readAloud() {
    if (!reader.supported()) return ctx.toast(t('ra.unsupported'));
    if (reader.isPlaying()) reader.stop();
    else reader.start();
  }

  function openVoices() {
    const d = dialog('dlg-voices', false);
    const lang = settings.docLang;
    const voices = availableVoices(lang);
    const map = loadVoiceMap();
    const chars = [...new Set(editor.getBlocks().filter((b) => b.type === 'character').map((b) => b.text.replace(/\(.*?\)/g, '').trim().toUpperCase()).filter(Boolean))];
    const row = (key: string, label: string) => {
      const cur = voiceFor(key === '#narrator' ? null : key, lang, map);
      return `<div class="voice-row"><span class="voice-name">${esc(label)}</span>
        <select class="text-input" data-voice="${esc(key)}">${voices
          .map((v) => `<option value="${esc(v.voiceURI)}"${cur?.voiceURI === v.voiceURI ? ' selected' : ''}>${esc(v.name)} (${esc(v.lang)})</option>`)
          .join('')}</select>
        <button type="button" class="icon-btn" data-try="${esc(key)}" title="${esc(t('ra.try'))}" aria-label="${esc(t('ra.try'))}">${ICON.play}</button></div>`;
    };
    d.innerHTML = `${head(t('ra.voices'), esc(t('ra.voicesDesc')))}
      ${voices.length ? `<div class="voice-list">${row('#narrator', t('ra.narrator'))}${chars.map((c) => row(c, c)).join('')}</div>` : `<div class="fd-empty"><p>${esc(t('ra.noVoices'))}</p></div>`}
      <div class="flex justify-end gap-2 pt-3"><button type="button" class="btn btn-primary" data-close><span>${esc(t('set.done'))}</span></button></div>`;
    d.onchange = (e) => {
      const el = e.target as HTMLSelectElement;
      if (!el.dataset.voice) return;
      map[el.dataset.voice] = el.value;
      saveVoiceMap(map);
    };
    d.onclick = (e) => {
      const key = (e.target as HTMLElement).closest<HTMLElement>('[data-try]')?.dataset.try;
      if (!key) return;
      const u = new SpeechSynthesisUtterance(key === '#narrator' ? t('ra.sampleNarrator') : t('ra.sample', { name: key }));
      const v = voiceFor(key === '#narrator' ? null : key, lang, map);
      if (v) u.voice = v;
      u.lang = lang;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    };
    if (!d.open) d.showModal();
  }

  /* ------------------------------------------------------------------ */
  /* Actions                                                             */
  /* ------------------------------------------------------------------ */

  const actions: Record<string, () => void> = {
    'line-history': () => void openLineHistory(),
    'toggle-track': toggleTracking,
    'toggle-show-revisions': () => {
      settings.showRevisions = !settings.showRevisions;
      ctx.applySettings();
      refreshScreen();
    },
    'accept-reject': openAcceptReject,
    'date-writers': openDateWriters,
    'mark-change': () => markChange(true),
    'unmark-change': () => markChange(false),
    timeline: () => void openTimeline(),
    'duplicate-doc': () => void duplicateDoc(),
    'save-snapshot': openSaveSnapshot,
    snapshots: () => void openTimeline(true),
    'dlg-scene-numbers': openSceneNumbers,
    'dlg-headers': openHeaders,
    'dlg-mores': openMores,
    'dlg-watermark': openWatermark,
    'toggle-lock-pages': toggleLockPages,
    'toggle-separate-scene': toggleSeparateScene,
    'toggle-omit-scene': toggleOmitScene,
    'fmt-b': () => editor.toggleFormat('b'),
    'fmt-i': () => editor.toggleFormat('i'),
    'fmt-u': () => editor.toggleFormat('u'),
    'fmt-s': () => editor.toggleFormat('s'),
    tagger: openTagger,
    shorten: openShorten,
    'read-aloud': readAloud,
    'read-voices': openVoices,
  };
  for (const tab of TABS) actions[`settings-${tab}`] = () => openSettings(tab);

  return {
    actions,
    check,
    refreshScreen,
    layoutOptions,
    revisedSet,
    revLabel,
    updateFormatButtons,
    renderTags,
    maybeAutoSnapshot,
    readAloud,
    resetRevisionCache: () => (revCache = null),
  };
}
