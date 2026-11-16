/**
 * Shared UI effects:
 *  - theme switch (JustCode14 design) on every page
 *  - animated theme change: View Transitions API, "circle" reveal growing from
 *    the switch (ported from Skiper UI's Theme_buttons_002 / rudrodip's
 *    theme-toggle-effect)
 *  - full-screen loader (TamaniPhiri spinner with the Terra Script mark)
 */

const STYLE_ID = 'theme-transition-styles';

const isDark = () => document.documentElement.classList.contains('dark');
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Run `update` (which flips the theme) inside a circular reveal from `from`. */
export function themeTransition(update: () => void, from?: Element | null) {
  const start = (document as Document & { startViewTransition?: (cb: () => void) => unknown }).startViewTransition;
  if (!start || reducedMotion()) {
    update();
    return;
  }
  const r = from?.getBoundingClientRect();
  const x = r ? r.left + r.width / 2 : window.innerWidth;
  const y = r ? r.top + r.height / 2 : 0;
  const radius = Math.ceil(Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)));
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = `
    ::view-transition-group(root) {
      animation-duration: 1s;
      animation-timing-function: var(--expo-out);
    }
    ::view-transition-new(root),
    .dark::view-transition-new(root) {
      animation-name: reveal-theme;
    }
    ::view-transition-old(root),
    .dark::view-transition-old(root) {
      animation: none;
      z-index: -1;
    }
    @keyframes reveal-theme {
      from { clip-path: circle(0px at ${x}px ${y}px); }
      to { clip-path: circle(${radius}px at ${x}px ${y}px); }
    }`;
  start.call(document, update);
}

/** Theme switches: checked = light (sun), unchecked = dark (moon). */
export function initThemeSwitches(onToggle: (dark: boolean, source: Element) => void) {
  for (const input of document.querySelectorAll<HTMLInputElement>('.theme-switch-input')) {
    input.checked = !isDark();
    input.addEventListener('change', () => {
      const wantDark = !input.checked;
      // Keep the knob where it was until the page itself switches, so both move together.
      input.checked = !isDark();
      onToggle(wantDark, input.closest('.theme-switch') ?? input);
    });
  }
}

export function syncThemeSwitches() {
  for (const input of document.querySelectorAll<HTMLInputElement>('.theme-switch-input')) input.checked = !isDark();
}

/* ------------------------------------------------------------------ */
/* Loader                                                              */
/* ------------------------------------------------------------------ */

export function hideLoader() {
  const el = document.getElementById('app-loader');
  if (!el || el.classList.contains('is-done')) return;
  el.classList.add('is-done');
  el.setAttribute('aria-busy', 'false');
  setTimeout(() => (el.hidden = true), 400);
}

export function showLoader() {
  const el = document.getElementById('app-loader');
  if (!el) return;
  el.hidden = false;
  el.setAttribute('aria-busy', 'true');
  requestAnimationFrame(() => el.classList.remove('is-done'));
}
