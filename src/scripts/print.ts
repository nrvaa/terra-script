import { expand } from './rich';
import type { Block, Run, TitlePage } from './types';

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

interface PrintOptions {
  sceneNumbers: boolean;
  /** Scene number of each scene heading (block index → label). */
  labels?: Map<number, string>;
}

/** Build print-ready HTML (title page + script) from the document model. */
export function buildPrintHtml(blocks: Block[], tp: TitlePage, opts: PrintOptions): string {
  const parts: string[] = [];

  if (tp.title.trim()) {
    parts.push(`<section class="p-title">
      <div class="p-title-main">
        <h1>${esc(tp.title)}</h1>
        ${tp.credit ? `<p>${esc(tp.credit)}</p>` : ''}
        ${tp.author ? `<p>${esc(tp.author).replace(/\n/g, '<br>')}</p>` : ''}
        ${tp.source ? `<p class="p-source">${esc(tp.source).replace(/\n/g, '<br>')}</p>` : ''}
      </div>
      <div class="p-title-foot">
        <div>${esc(tp.contact).replace(/\n/g, '<br>')}</div>
        <div>${esc(tp.draftDate)}</div>
      </div>
    </section>`);
  }

  const body: string[] = [];
  let scene = 0;
  let lastDialogueStart = -1; // index in body[] of the previous dialogue group
  const printable = blocks.map((b, i) => ({ ...b, idx: i })).filter((b) => b.type !== 'note' && b.type !== 'section');

  for (let i = 0; i < printable.length; i++) {
    const b = printable[i];
    if (b.type === 'character') {
      const group: Block[] = [b];
      while (i + 1 < printable.length && ['parenthetical', 'dialogue', 'lyrics'].includes(printable[i + 1].type)) {
        group.push(printable[++i]);
      }
      const html = `<div class="p-dlg">${group.map(renderLine).join('')}</div>`;
      if (b.dual && lastDialogueStart === body.length - 1 && lastDialogueStart >= 0) {
        body[lastDialogueStart] = `<div class="p-dual">${body[lastDialogueStart]}${html}</div>`;
        lastDialogueStart = -1;
      } else {
        body.push(html);
        lastDialogueStart = body.length - 1;
      }
      continue;
    }
    lastDialogueStart = -1;
    if (b.type === 'scene') {
      scene++;
      const label = esc(opts.labels?.get(b.idx) ?? String(scene));
      const n = opts.sceneNumbers ? `<span class="p-sn p-sn-l">${label}</span><span class="p-sn p-sn-r">${label}</span>` : '';
      body.push(`<div class="p-el p-scene">${n}${rich(b.text.toUpperCase(), b.fmt)}</div>`);
      continue;
    }
    body.push(renderLine(b));
  }

  parts.push(`<section class="p-script">${body.join('')}</section>`);
  return parts.join('');
}

function renderLine(b: Block): string {
  let t = b.text;
  if (['character', 'transition', 'shot', 'act', 'endact'].includes(b.type)) t = t.toUpperCase();
  if (b.type === 'parenthetical' && t.trim() && !t.trim().startsWith('(')) t = `(${t.trim()})`;
  const fmt = t.length === b.text.length ? b.fmt : undefined;
  return `<div class="p-el p-${b.type}">${rich(t, fmt) || '&nbsp;'}</div>`;
}

/** Text with its bold / italic / underline / strikethrough runs as HTML. */
function rich(text: string, fmt?: Run[]): string {
  if (!fmt?.length) return esc(text);
  const flags = expand(text.length, fmt);
  let out = '';
  let k = 0;
  while (k < text.length) {
    let e = k + 1;
    while (e < text.length && flags[e] === flags[k]) e++;
    let seg = esc(text.slice(k, e));
    for (const f of flags[k]) seg = `<${f}>${seg}</${f}>`;
    out += seg;
    k = e;
  }
  return out;
}
