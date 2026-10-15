import { useLayoutEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router';

import { cn } from '@web/lib/cn.ts';
import { NAV_SECTIONS, activeNavPath } from '@web/shell/nav-config.ts';

/**
 * The rail's navigation list. The active entry is marked with a single pill
 * that slides between items rather than a background painted on each row, which
 * is what makes the movement read as one object (PRD §7.4).
 *
 * The pill is positioned from measured geometry, so the two numbers that change
 * per route are written to CSS custom properties on the container — the one
 * inline-style shape the design system allows (RULESET R3.4). Doing it on the
 * node rather than in React state keeps the measurement out of the render path.
 */
export function SidebarNav({ className }: { className?: string }) {
  const { pathname } = useLocation();
  const active = activeNavPath(pathname);
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const apply = (): void => {
      const target =
        active === null
          ? null
          : container.querySelector<HTMLElement>(`[data-nav-path="${CSS.escape(active)}"]`);

      if (!target) {
        container.style.setProperty('--indicator-opacity', '0');
        return;
      }
      container.style.setProperty('--indicator-top', `${target.offsetTop}px`);
      container.style.setProperty('--indicator-height', `${target.offsetHeight}px`);
      container.style.setProperty('--indicator-opacity', '1');
    };

    apply();

    // Fonts landing or the window resizing change row heights; re-measure.
    const observer = new ResizeObserver(apply);
    observer.observe(container);
    return () => observer.disconnect();
  }, [active]);

  return (
    <div
      ref={containerRef}
      // Defaults keep the pill invisible for the first paint, before the
      // layout effect has measured anything.
      className={cn('relative [--indicator-opacity:0]', className)}
    >
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-x-0 rounded-control bg-surface-2',
          'top-(--indicator-top) h-(--indicator-height) opacity-(--indicator-opacity)',
          'transition-[top,height,opacity] duration-(--dur-macro) ease-spring',
        )}
      />

      <nav aria-label="Primary">
        {NAV_SECTIONS.map((section) => (
          <div key={section.id} className="pb-1">
            <h2
              id={`nav-section-${section.id}`}
              className="px-3 pb-1 pt-3 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-text-subtle"
            >
              {section.label}
            </h2>
            <ul aria-labelledby={`nav-section-${section.id}`} className="flex flex-col gap-0.5">
              {section.items.map((item) => {
                const isActive = item.path === active;
                const Icon = item.icon;
                return (
                  <li key={item.id}>
                    <Link
                      to={item.path}
                      data-nav-path={item.path}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        'group relative flex h-8 items-center gap-2.5 rounded-control px-3 text-sm',
                        'transition-colors duration-(--dur-micro) ease-out',
                        isActive
                          ? 'font-medium text-text'
                          : 'text-text-muted hover:bg-surface-2 hover:text-text',
                      )}
                    >
                      <Icon
                        className={cn(
                          'size-4 shrink-0 transition-colors duration-(--dur-micro) ease-out',
                          isActive ? 'text-text' : 'text-text-subtle group-hover:text-text-muted',
                        )}
                        aria-hidden="true"
                      />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}
