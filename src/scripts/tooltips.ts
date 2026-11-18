/**
 * Tooltips for every page, replacing the browser's own `title` bubbles (which
 * can't be styled). The look is adapted from a Uiverse.io hover card by
 * Amine-maker: a rounded card that grows from the element (scale 0 → 1) while
 * coming into focus from a blur, with a soft inner card and a pulsing dot.
 *
 * Any element with a `title` works as before: on hover (or keyboard focus) its
 * title moves to `data-tip` so the native bubble never shows, and the card
 * appears. "Undo (Ctrl+Z)" shows "Undo" with "Ctrl+Z" on a second line.
 * It is a popover (top layer), so it also shows above open dialogs.
 */

const SHOW_DELAY = 380;
const HIDE_AFTER = 180;
/** A trailing "(…)" that is a keyboard shortcut. */
const SHORTCUT = /^(.*?)\s*\(((?:Ctrl|Alt|Shift|Esc|Enter|Tab|F\d|⌘)[^()]*)\)$/;

let tip: HTMLElement | null = null;
/** Popovers (top layer) where the browser has them; a plain fixed box elsewhere. */
const HAS_POPOVER = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;
const popoverOpen = (t: HTMLElement) => (HAS_POPOVER ? t.matches(':popover-open') : t.style.display === 'block');
let owner: HTMLElement | null = null;
let showTimer: number | undefined;
let hideTimer: number | undefined;

function ensureTip(): HTMLElement {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'tt';
  tip.setAttribute('role', 'tooltip');
  tip.id = 'app-tooltip';
  if (HAS_POPOVER) tip.setAttribute('popover', 'manual');
  tip.innerHTML = '<div class="tt-inner"><span class="tt-dot" aria-hidden="true"></span><span class="tt-text"><span class="tt-main"></span><span class="tt-sub"></span></span></div>';
  document.body.appendChild(tip);
  return tip;
}

/** Take over an element's title (keeping it as its accessible name when it has no other). */
function adopt(el: HTMLElement): string {
  const title = el.getAttribute('title');
  if (title) {
    el.dataset.tip = title;
    el.removeAttribute('title');
    if (!el.hasAttribute('aria-label') && !el.textContent?.trim()) el.setAttribute('aria-label', title);
  }
  return el.dataset.tip ?? '';
}

const tipTarget = (node: EventTarget | null) => (node as Element | null)?.closest?.<HTMLElement>('[title], [data-tip]') ?? null;

function place(el: HTMLElement) {
  const t = ensureTip();
  const r = el.getBoundingClientRect();
  const w = t.offsetWidth;
  const h = t.offsetHeight;
  const gap = 10;
  // Above the element if there is room, otherwise below; kept inside the window.
  const above = r.top - h - gap >= 6;
  const top = above ? r.top - h - gap : Math.min(window.innerHeight - h - 6, r.bottom + gap);
  const left = Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2));
  t.style.top = `${Math.round(top)}px`;
  t.style.left = `${Math.round(left)}px`;
  // Grow from the side that points at the element.
  const ox = Math.max(10, Math.min(w - 10, r.left + r.width / 2 - left));
  t.style.transformOrigin = `${Math.round(ox)}px ${above ? '100%' : '0%'}`;
  t.dataset.side = above ? 'top' : 'bottom';
}

function show(el: HTMLElement) {
  const text = adopt(el).trim();
  if (!text || !el.isConnected) return;
  const t = ensureTip();
  const m = text.match(SHORTCUT);
  t.querySelector('.tt-main')!.textContent = m ? m[1] : text;
  const sub = t.querySelector<HTMLElement>('.tt-sub')!;
  sub.textContent = m ? m[2] : '';
  sub.hidden = !m;
  t.classList.toggle('is-long', text.length > 60);
  window.clearTimeout(hideTimer);
  owner = el;
  el.setAttribute('aria-describedby', 'app-tooltip');
  // Re-open so it lands on top of whatever dialog opened since last time.
  if (HAS_POPOVER && popoverOpen(t)) t.hidePopover();
  t.classList.remove('is-on');
  if (HAS_POPOVER) t.showPopover();
  else t.style.display = 'block';
  place(el);
  requestAnimationFrame(() => t.classList.add('is-on'));
}

function hide() {
  window.clearTimeout(showTimer);
  if (!tip || !owner) return;
  owner.removeAttribute('aria-describedby');
  owner = null;
  const t = tip;
  t.classList.remove('is-on');
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (owner) return;
    if (HAS_POPOVER) {
      if (popoverOpen(t)) t.hidePopover();
    } else t.style.display = '';
  }, HIDE_AFTER);
}

export function initTooltips() {
  // Mouse / pen: after a short pause, like the native bubble. Touch never shows tooltips.
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = tipTarget(e.target);
    if (!el || el === owner) return;
    adopt(el);
    window.clearTimeout(showTimer);
    if (owner) hide();
    showTimer = window.setTimeout(() => show(el), owner ? 60 : SHOW_DELAY);
  });
  document.addEventListener('pointerout', (e) => {
    const el = tipTarget(e.target);
    if (!el) return;
    // Still inside the same element (moving over its icon or label)?
    if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
    window.clearTimeout(showTimer);
    if (el === owner) hide();
  });
  // Keyboard: show for the focused control.
  document.addEventListener('focusin', (e) => {
    const el = tipTarget(e.target);
    if (!el || !(e.target as Element).matches(':focus-visible')) return;
    window.clearTimeout(showTimer);
    showTimer = window.setTimeout(() => show(el), 120);
  });
  document.addEventListener('focusout', () => {
    window.clearTimeout(showTimer);
    hide();
  });
  // Anything that moves things around or acts: hide.
  for (const type of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(type, hide, { capture: true, passive: true });
  window.addEventListener('scroll', hide, { capture: true, passive: true });
  window.addEventListener('blur', hide);
}
