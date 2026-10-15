import { useEffect } from 'react';
import { useOutletContext } from 'react-router';

import type { Crumb, ShellOutletContext } from '@web/shell/breadcrumb.ts';

/**
 * Publish the crumbs a detail route adds after the rail's own two.
 *
 * The trail is cleared on unmount, so leaving the page returns the topbar to
 * naming the rail entry alone. `trail` must be referentially stable across
 * renders — a `useMemo` over the data it is built from — or the effect re-runs
 * every render and the shell re-renders in a loop.
 */
export function useBreadcrumbTrail(trail: readonly Crumb[] | null): void {
  const context = useOutletContext<ShellOutletContext | null>();
  const setTrail = context?.setBreadcrumbTrail;

  useEffect(() => {
    if (setTrail === undefined) return;
    setTrail(trail);
    return () => {
      setTrail(null);
    };
  }, [setTrail, trail]);
}
