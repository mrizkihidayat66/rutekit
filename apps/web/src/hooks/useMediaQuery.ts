import { useEffect, useState } from 'react';

/**
 * Subscribe to a media query. Used for breakpoints *and* for
 * `prefers-reduced-motion`, so both react live to the user changing them.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const media = window.matchMedia(query);
    setMatches(media.matches);
    const listener = (event: MediaQueryListEvent): void => setMatches(event.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [query]);

  return matches;
}

/** True when the user has asked for reduced motion. Drives JS-side animations. */
export function useReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}

/** True below the 1024px breakpoint, where the sidebar becomes an off-canvas drawer. */
export function useIsCompactLayout(): boolean {
  return useMediaQuery('(max-width: 1023.98px)');
}
