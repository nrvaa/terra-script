/**
 * Web only: suggest the Windows desktop app, which keeps scripts on the PC
 * itself instead of in browser storage (which the browser limits and can wipe).
 * Every promo element is marked [data-web-only] and starts hidden, so the
 * desktop app never shows it, not even for a moment.
 */
import { isDesktop } from './save-file';

export const DESKTOP_APP_URL = '/downloads/TerraScript-Setup.exe';
const DISMISS_KEY = 'tewrite:desktopPromoHidden';

/** The installer is Windows-only: don't offer it on macOS, Linux or phones. */
export const offerDesktopApp = () => !isDesktop() && /Windows/i.test(navigator.userAgent);

export function initDesktopPromo(root: ParentNode = document) {
  if (!offerDesktopApp()) return;
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    /* storage blocked: show it */
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-web-only]')) {
    if (dismissed && el.dataset.dismissible) continue;
    el.hidden = false;
  }
  for (const b of root.querySelectorAll<HTMLElement>('[data-promo-dismiss]')) {
    b.addEventListener('click', () => {
      try {
        localStorage.setItem(DISMISS_KEY, '1');
      } catch {
        /* ignore */
      }
      b.closest<HTMLElement>('[data-web-only]')!.hidden = true;
    });
  }
}
