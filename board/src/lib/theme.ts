/**
 * The board's themes: Day, Dusk and Night, the steps a ship's chart display dims through, or `auto` to follow the
 * system. The choice is a per-viewer preference kept in localStorage; the page carries the resolved theme as
 * `data-chart` on the root, which styles/tokens.css keys its colour sets on.
 */
export type Theme = 'day' | 'dusk' | 'night';
export type ThemePref = Theme | 'auto';

/** The choices in the order the menu shows them: the id, its label, and what it does in a sentence. */
export const THEME_CHOICES: [ThemePref, string, string][] = [
  ['day', 'Day', 'Pale-blue water and white paper'],
  ['dusk', 'Dusk', 'Dimmed slate blue'],
  ['night', 'Night', 'Deep navy'],
  ['auto', 'Auto', 'Day or Night, to match Claude or your system'],
];

const KEY = 'keel.theme';
const DARK = '(prefers-color-scheme: dark)';

export const isThemePref = (v: unknown): v is ThemePref => v === 'day' || v === 'dusk' || v === 'night' || v === 'auto';

/**
 * The theme a choice comes to. `auto` follows the host page when it says light or dark (claude.ai marks an artifact's
 * root with `data-theme`), and the system setting otherwise.
 */
export function resolveTheme(pref: ThemePref, hostTheme: string | null, systemDark: boolean): Theme {
  if (pref !== 'auto') return pref;
  if (hostTheme === 'dark') return 'night';
  if (hostTheme === 'light') return 'day';
  return systemDark ? 'night' : 'day';
}

/** The saved choice; Day when nothing is saved or storage is blocked. */
export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return isThemePref(v) ? v : 'day';
  } catch {
    return 'day';
  }
}

export function saveThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* per-viewer preference only */
  }
}

let unwatch: (() => void) | null = null;

/**
 * Puts a choice's theme on the page and reports it. While the choice is `auto` it keeps watching the system setting
 * and the host's `data-theme`, and reports each change.
 */
export function watchTheme(pref: ThemePref, onTheme: (theme: Theme) => void): void {
  unwatch?.();
  unwatch = null;
  const root = document.documentElement;
  const media = typeof window.matchMedia === 'function' ? window.matchMedia(DARK) : null;
  const apply = (): void => {
    const theme = resolveTheme(pref, root.getAttribute('data-theme'), media?.matches ?? false);
    root.setAttribute('data-chart', theme);
    onTheme(theme);
  };
  apply();
  if (pref !== 'auto') return;
  media?.addEventListener('change', apply);
  const host = new MutationObserver(apply);
  host.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  unwatch = () => {
    media?.removeEventListener('change', apply);
    host.disconnect();
  };
}
