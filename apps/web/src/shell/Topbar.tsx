import { Menu, Search } from 'lucide-react';
import { Fragment } from 'react';
import { Link, useLocation } from 'react-router';

import { ThemeToggle } from '@web/components/ThemeToggle.tsx';
import { cn } from '@web/lib/cn.ts';
import { activeNavItem, navSectionOf } from '@web/shell/nav-config.ts';
import type { Crumb } from '@web/shell/breadcrumb.ts';

export interface TopbarProps {
  /** Renders the off-canvas trigger; false on desktop where the rail is fixed. */
  compact: boolean;
  onOpenNav: () => void;
  onOpenPalette: () => void;
  /** Crumbs the current route adds after the rail entry, e.g. a provider's name. */
  trail: readonly Crumb[] | null;
}

/**
 * The window bar. It names the current view the way an OS title bar does, and
 * carries the two global affordances: the command palette and the theme switch.
 *
 * The trail is the section, then the rail entry, then whatever the route
 * published. Only the rail entry is a link — the section is a label rather than
 * a destination, and the last crumb is the page being read.
 */
export function Topbar({ compact, onOpenNav, onOpenPalette, trail }: TopbarProps) {
  const { pathname } = useLocation();
  const item = activeNavItem(pathname);
  const section = item ? navSectionOf(item) : undefined;

  const crumbs: Crumb[] = [];
  if (section) crumbs.push({ label: section.label });
  if (item) crumbs.push(trail === null ? { label: item.label } : { label: item.label, to: item.path });
  if (trail) crumbs.push(...trail);

  return (
    <header className="flex h-topbar shrink-0 items-center justify-between gap-3 border-b border-border px-3">
      <div className="flex min-w-0 items-center gap-2">
        {compact ? (
          <button
            type="button"
            onClick={onOpenNav}
            aria-label="Open navigation"
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-control text-text-muted',
              'transition-colors duration-(--dur-micro) ease-out hover:bg-surface-2 hover:text-text',
            )}
          >
            <Menu className="size-4" aria-hidden="true" />
          </button>
        ) : null}

        <nav aria-label="Breadcrumb" className="min-w-0">
          <ol className="flex min-w-0 items-center gap-1.5 text-sm">
            {crumbs.length === 0 ? (
              <li className="truncate font-medium text-text" aria-current="page">
                Not found
              </li>
            ) : null}

            {crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1;
              return (
                <Fragment key={`${crumb.label}-${String(index)}`}>
                  {index > 0 ? (
                    <li aria-hidden="true" className="shrink-0 text-text-subtle">
                      /
                    </li>
                  ) : null}
                  <li className="min-w-0 truncate">
                    {crumb.to === undefined || last ? (
                      <span
                        className={cn(last ? 'font-medium text-text' : 'text-text-subtle')}
                        aria-current={last ? 'page' : undefined}
                      >
                        {crumb.label}
                      </span>
                    ) : (
                      <Link
                        to={crumb.to}
                        className="rounded-key text-text-subtle outline-none transition-colors duration-(--dur-micro) ease-out hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
                      >
                        {crumb.label}
                      </Link>
                    )}
                  </li>
                </Fragment>
              );
            })}
          </ol>
        </nav>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onOpenPalette}
          className={cn(
            'hidden h-8 items-center gap-2 rounded-control border border-border bg-surface-2 px-2.5 text-xs text-text-subtle',
            'transition-colors duration-(--dur-micro) ease-out hover:border-border-strong hover:text-text sm:flex',
          )}
        >
          <Search className="size-3.5" aria-hidden="true" />
          <span className="pr-6">Search or jump to…</span>
          <kbd className="rounded-key border border-border bg-surface-3 px-1 text-[0.625rem] leading-4 text-text-muted">
            ⌘K
          </kbd>
        </button>

        <button
          type="button"
          onClick={onOpenPalette}
          aria-label="Search or jump to"
          className={cn(
            'flex size-8 items-center justify-center rounded-control border border-border bg-surface-2 text-text-subtle sm:hidden',
            'transition-colors duration-(--dur-micro) ease-out hover:text-text',
          )}
        >
          <Search className="size-3.5" aria-hidden="true" />
        </button>

        <ThemeToggle />
      </div>
    </header>
  );
}
