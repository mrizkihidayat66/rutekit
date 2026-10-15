export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'rutekit.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';
const CHANGE_EVENT = 'rutekit:theme-change';

/**
 * Theme lives outside React state because the pre-paint script in index.html
 * needs it too, and because a theme flip must not re-render the tree.
 */
export function readThemePreference(): ThemePreference {
  if (typeof localStorage === 'undefined') return 'system';
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') {
    return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
  }
  return preference;
}

/**
 * Write the resolved theme to <html> and remember the preference.
 *
 * The theme is applied outside React, so anything that *displays* the current
 * preference (the toggle, and later the settings page) needs a way to hear
 * about a change it did not make — hence the event.
 */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolved;
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, preference);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<ThemePreference>(CHANGE_EVENT, { detail: preference }));
  }
  return resolved;
}

/** Subscribe to preference changes from any source. Returns an unsubscribe fn. */
export function watchThemePreference(
  onChange: (preference: ThemePreference) => void,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (event: Event): void => {
    onChange((event as CustomEvent<ThemePreference>).detail);
  };
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

/**
 * Enable the animated theme transition only after the first paint, so the very
 * first frame never animates in from an unstyled palette.
 */
export function enableThemeTransition(): void {
  if (typeof document === 'undefined') return;
  requestAnimationFrame(() => {
    document.documentElement.classList.add('theme-ready');
  });
}

export function watchSystemTheme(onChange: (resolved: ResolvedTheme) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const media = window.matchMedia(DARK_QUERY);
  const listener = (event: MediaQueryListEvent): void => onChange(event.matches ? 'dark' : 'light');
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}
