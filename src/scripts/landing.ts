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

// Play the logo animation once on arrival; afterwards it runs on hover/focus.
const card = $('#logo-card');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (!reduced) {
  setTimeout(() => card.classList.add('is-on'), 500);
  setTimeout(() => card.classList.remove('is-on'), 3200);
}

// Feature cards slide in as they scroll into view (staggered).
const cards = document.querySelectorAll<HTMLElement>('.flip-reveal');
cards.forEach((c, i) => c.style.setProperty('--d', `${(i % 3) * 0.1}s`));
if ('IntersectionObserver' in window && !reduced) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('is-visible');
        io.unobserve(e.target);
      }
    },
    { threshold: 0.15 },
  );
  cards.forEach((c) => io.observe(c));
} else cards.forEach((c) => c.classList.add('is-visible'));

// Flip cards also flip on tap/click and with Enter/Space (hover isn't available on touch).
for (const card of document.querySelectorAll<HTMLElement>('.flip-card')) {
  const flip = () => {
    const on = card.classList.toggle('is-flipped');
    card.setAttribute('aria-pressed', String(on));
  };
  card.addEventListener('click', flip);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      flip();
    }
  });
}

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
