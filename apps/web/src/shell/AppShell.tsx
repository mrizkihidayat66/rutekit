import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation } from 'react-router';

import { ErrorBoundary } from '@web/components/ErrorBoundary.tsx';
import { Skeleton, SkeletonText } from '@web/components/ui/Skeleton.tsx';
import { useIsCompactLayout } from '@web/hooks/useMediaQuery.ts';
import { cn } from '@web/lib/cn.ts';
import { CommandPalette } from '@web/shell/CommandPalette.tsx';
import { CompactNav } from '@web/shell/CompactNav.tsx';
import { ShellFooter } from '@web/shell/ShellFooter.tsx';
import { SidebarPanel } from '@web/shell/SidebarPanel.tsx';
import { Topbar } from '@web/shell/Topbar.tsx';
import type { Crumb, ShellOutletContext } from '@web/shell/breadcrumb.ts';

/**
 * Shown while a lazy route chunk downloads. It renders inside the shell, so the
 * rail and topbar stay put and the viewport is never blank (RULESET R6.3).
 */
function RouteLoading() {
  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <div className="flex flex-col gap-2">
        <Skeleton shape="title" />
        <Skeleton shape="text" className="w-72" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="rounded-card border border-border bg-surface-1 p-4">
            <SkeletonText lines={4} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The OS-style frame: a rail and a window, both floating cards on the page
 * background, with the window owning the only scroller in the app.
 *
 * The grid deliberately has no max-width (R13) — a capped shell leaves dead
 * margins on wide monitors. Pages constrain their own content instead, so
 * data-dense views can use the whole canvas.
 */
export function AppShell() {
  const { pathname } = useLocation();
  const compact = useIsCompactLayout();
  const [navOpen, setNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Detail routes publish the crumbs the rail cannot supply — the name of the
  // provider, job or combo being looked at (see `shell/breadcrumb.ts`).
  const [breadcrumbTrail, setBreadcrumbTrail] = useState<readonly Crumb[] | null>(null);

  // The palette supersedes the rail, so opening it dismisses the drawer — two
  // overlays that each trap focus cannot be on screen at once, or the one
  // underneath keeps stealing focus from the one on top.
  const openPalette = useCallback(() => {
    setNavOpen(false);
    setPaletteOpen(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setNavOpen(false);
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Stable so publishing a trail re-renders the page subtree only when the trail
  // itself changes, not on every shell redraw.
  const outletContext = useMemo<ShellOutletContext>(
    () => ({ setBreadcrumbTrail }),
    [setBreadcrumbTrail],
  );

  // Navigating dismisses the off-canvas rail; so does growing past the breakpoint.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!compact) setNavOpen(false);
  }, [compact]);

  return (
    <div
      className={cn(
        'grid h-dvh gap-4 p-4',
        compact ? 'grid-cols-1' : 'grid-cols-[272px_minmax(0,1fr)]',
      )}
    >
      {compact ? null : (
        <aside className="flex min-h-0 flex-col overflow-hidden rounded-sidebar border border-border bg-surface-1 shadow-card">
          <SidebarPanel onOpenPalette={openPalette} />
        </aside>
      )}

      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-sidebar border border-border bg-surface-1 shadow-card">
        <Topbar
          compact={compact}
          onOpenNav={() => setNavOpen(true)}
          onOpenPalette={openPalette}
          trail={breadcrumbTrail}
        />

        <main className="scrollbar-none min-h-0 flex-1 overflow-y-auto">
          <ErrorBoundary key={pathname}>
            <Suspense fallback={<RouteLoading />}>
              <Outlet context={outletContext} />
            </Suspense>
          </ErrorBoundary>
        </main>

        <ShellFooter />
      </div>

      {compact ? (
        <CompactNav open={navOpen} onOpenChange={setNavOpen} onOpenPalette={openPalette} />
      ) : null}

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
