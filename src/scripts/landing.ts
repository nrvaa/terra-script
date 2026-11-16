import { applyI18n, getLang, sampleScript, setLang, t, type Lang } from './i18n';
import { createProject, editorUrl, listProjects, migrateLegacy } from './projects';
import { initThemeSwitches, showLoader, hideLoader, syncThemeSwitches, themeTransition } from './ui-effects';
import { emptyTitlePage } from './types';

const SETTINGS_KEY = 'tewrite:settings';
const readSettings = (): Record<string, unknown> => {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
};
const writeSettings = (patch: Record<string, unknown>) => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...readSettings(), ...patch }));
  } catch {
    /* ignore */
  }
};
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

setLang((readSettings().lang as Lang) || 'en');
let projectCount = 0;

function translate() {
  applyI18n();
  document.title = t('land.pageTitle');
  // Returning writers go straight to their projects.
  if (projectCount) $('#cta-main span').textContent = projectCount === 1 ? t('land.continue1') : t('land.continue', { n: projectCount });
  document.documentElement.classList.remove('i18n-pending');
}

const langSelect = $<HTMLSelectElement>('#lang-select');
langSelect.value = getLang();
langSelect.addEventListener('change', () => {
  setLang(langSelect.value as Lang);
  writeSettings({ lang: getLang() });
  translate();
});

initThemeSwitches((dark, source) =>
  themeTransition(() => {
    document.documentElement.classList.toggle('dark', dark);
    writeSettings({ theme: dark ? 'dark' : 'light' });
    syncThemeSwitches();
  }, source),
);

$('#cta-sample').addEventListener('click', async () => {
  showLoader();
  try {
    const id = await createProject({
      version: 2,
      titlePage: { ...emptyTitlePage(), title: t('sample.title'), credit: t('tp.credit'), author: t('sample.author') },
      blocks: sampleScript(getLang()),
    });
    location.href = editorUrl(id);
  } catch {
    const el = $('#toast');
    hideLoader();
    el.textContent = t('proj.storageError');
    el.hidden = false;
  }
});

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const card = $('#logo-card');

/** Logo card animation, played once on arrival; afterwards it runs on hover/focus. */
function playLogoCard() {
  if (reduced) return;
  setTimeout(() => card.classList.add('is-on'), 500);
  setTimeout(() => card.classList.remove('is-on'), 3200);
}

/* Intro: morphing words, then the logo; shown once per visit. */
const INTRO_MS = 5400;
const root = document.documentElement;
function endIntro() {
  if (!root.classList.contains('intro-on') || root.classList.contains('intro-out')) return;
  try {
    sessionStorage.setItem('tewrite:intro', '1');
  } catch {
    /* ignore */
  }
  root.classList.add('intro-out');
  setTimeout(() => {
    root.classList.remove('intro-on', 'intro-out');
    $('#intro').remove();
    playLogoCard();
    startWaves();
  }, 700);
}
if (root.classList.contains('intro-on')) {
  const timer = setTimeout(endIntro, INTRO_MS);
  const skip = () => {
    clearTimeout(timer);
    endIntro();
  };
  $('#intro').addEventListener('click', skip);
  window.addEventListener('keydown', skip, { once: true });
  window.addEventListener('wheel', skip, { once: true, passive: true });
} else {
  $('#intro').remove();
  playLogoCard();
  startWaves();
}

/* Wave grid background (Three.js, loaded after the page is up). */
function waveTheme() {
  return root.classList.contains('dark') ? 'dark' : 'light';
}
function supportsWebGL() {
  try {
    const c = document.createElement('canvas');
    return Boolean(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}
/** Start the background once the intro is out of the way (keeps the intro smooth). */
function startWaves() {
  if (!supportsWebGL()) return;
  const start = () =>
    import('./wave-grid')
      .then(({ mountWaveGrid, TERRA_WAVES }) => {
        const bg = $('#wave-bg');
        const small = window.innerWidth < 720;
        const grid = mountWaveGrid(bg, {
          theme: TERRA_WAVES[waveTheme()],
          gridSize: small ? 28 : 40,
          autoAnimate: !reduced,
          interactive: !reduced,
        });
        requestAnimationFrame(() => bg.classList.add('is-ready'));
        // Follow the light/dark theme switch.
        new MutationObserver(() => grid.setTheme(TERRA_WAVES[waveTheme()])).observe(root, { attributes: true, attributeFilter: ['class'] });
      })
      .catch(() => {
        /* the CSS gradient stays as the background */
      });
  if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 800 });
  else setTimeout(start, 200);
}

/* ------------------------------------------------------------------ */
/* Feature card stack: the active card swings out to the side and lands */
/* on top; the others rest behind it, slightly fanned.                  */
/* ------------------------------------------------------------------ */
const stack = $('#fstack');
const stackCards = Array.from(stack.querySelectorAll<HTMLElement>('.fcard'));
const stackTexts = Array.from(stack.querySelectorAll<HTMLElement>('.fstack-item'));
const prevBtn = $<HTMLButtonElement>('#fs-prev');
const nextBtn = $<HTMLButtonElement>('#fs-next');
const ROTATIONS = [4, -2, -9, 7];
const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
let active = 0;
let direction = 1;
let textToken = 0;

type Pose = { x: number; y: number; z: number; s: number; r: number; o: number };
const css = (p: Pose) => ({
  transform: `translate3d(${p.x}px, ${p.y}px, ${p.z}px) scale(${p.s}) rotateZ(${p.r}deg)`,
  opacity: String(p.o),
});
const restPose = (i: number): Pose => {
  const off = i - active;
  const a = Math.abs(off);
  return { x: off * 15, y: a * 6, z: -150 * a, s: 0.85 - a * 0.04, r: ROTATIONS[i % 4], o: 0.55 };
};
const ACTIVE_POSE: Pose = { x: 0, y: 0, z: 250, s: 1, r: 0, o: 1 };
const lastPose = new Map<HTMLElement, Pose>();

function layoutStack(animate: boolean) {
  stackCards.forEach((card, i) => {
    const off = i - active;
    const isActive = off === 0;
    const to = isActive ? ACTIVE_POSE : restPose(i);
    card.style.zIndex = String(isActive ? 100 : 10 - Math.abs(off));
    card.setAttribute('aria-hidden', String(!isActive));
    const from = lastPose.get(card) ?? to;
    lastPose.set(card, to);
    card.getAnimations().forEach((a) => a.cancel());
    Object.assign(card.style, css(to));
    if (!animate || reduced) return;
    if (isActive) {
      // Swing out to the side, then land on top of the pile.
      const swing: Pose = { x: direction === 1 ? -200 : 200, y: 0, z: 150, s: 1.05, r: -5, o: 1 };
      card.animate([css(from), css(swing), css(to)], { duration: 750, easing: EASE });
    } else {
      card.animate([css(from), css(to)], { duration: 750, easing: EASE });
    }
  });

  // Text: old one fades up and out, the new one rises in. A newer change
  // cancels a fade still running, so the text always matches the top card.
  const token = ++textToken;
  stackTexts.forEach((el) => el.getAnimations().forEach((a) => a.cancel()));
  const current = stackTexts.find((el) => !el.hidden);
  const swap = () => {
    if (token !== textToken) return;
    const show = stackTexts[active];
    stackTexts.forEach((el) => (el.hidden = el !== show));
    if (animate && !reduced) show.animate([{ opacity: 0, transform: 'translateY(25px)' }, { opacity: 1, transform: 'none' }], { duration: 350, easing: 'ease-out' });
  };
  if (animate && !reduced && current && current !== stackTexts[active]) {
    current.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-25px)' }], { duration: 300, easing: 'ease-in', fill: 'forwards' }).onfinish = swap;
  } else swap();

  $('#fs-index').textContent = String(active + 1);
  prevBtn.disabled = active === 0;
  nextBtn.disabled = active === stackCards.length - 1;
}

function goTo(i: number) {
  const n = stackCards.length;
  const next = ((i % n) + n) % n;
  if (next === active) return;
  direction = next > active ? 1 : -1;
  active = next;
  layoutStack(true);
}
prevBtn.addEventListener('click', () => active > 0 && goTo(active - 1));
nextBtn.addEventListener('click', () => active < stackCards.length - 1 && goTo(active + 1));
stack.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' && active < stackCards.length - 1) goTo(active + 1);
  else if (e.key === 'ArrowLeft' && active > 0) goTo(active - 1);
  else return;
  e.preventDefault();
});
// Click a card in the pile to bring it forward; swipe on touch screens.
stackCards.forEach((card, i) => card.addEventListener('click', () => goTo(i)));
let touchX: number | null = null;
stack.addEventListener('touchstart', (e) => (touchX = e.touches[0].clientX), { passive: true });
stack.addEventListener('touchend', (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (dx < -40 && active < stackCards.length - 1) goTo(active + 1);
  else if (dx > 40 && active > 0) goTo(active - 1);
});

// Auto-play while the stack is on screen, paused on hover / focus.
let paused = false;
let visible = false;
stack.addEventListener('pointerenter', () => (paused = true));
stack.addEventListener('pointerleave', () => (paused = false));
stack.addEventListener('focusin', () => (paused = true));
stack.addEventListener('focusout', () => (paused = false));
if ('IntersectionObserver' in window) {
  new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0.4 }).observe(stack);
}
if (!reduced) setInterval(() => !paused && visible && !document.hidden && goTo(active + 1), 4500);

layoutStack(false);

translate();
(async () => {
  try {
    await migrateLegacy();
    projectCount = (await listProjects()).length;
  } catch {
    projectCount = 0;
  }
  translate();
})();
