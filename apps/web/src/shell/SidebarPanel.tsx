import { Route, Search } from 'lucide-react';
import { Link } from 'react-router';

import { Badge } from '@web/components/ui/Badge.tsx';
import { useBranding } from '@web/hooks/use-system.ts';
import { cn } from '@web/lib/cn.ts';
import { SidebarNav } from '@web/shell/SidebarNav.tsx';

export interface SidebarPanelProps {
  className?: string;
  /** Opens the command palette; wired to the footer's hint button. */
  onOpenPalette?: (() => void) | undefined;
}

/**
 * The rail itself, shared by the desktop column and the compact-mode drawer so
 * the two can never drift apart. It carries no card styling — the desktop
 * column and the drawer each supply their own frame.
 */
export function SidebarPanel({ className, onOpenPalette }: SidebarPanelProps) {
  const branding = useBranding();

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <Link
        to="/"
        className="flex items-center gap-2.5 rounded-control px-3 py-3 transition-colors duration-(--dur-micro) ease-out hover:bg-surface-2"
      >
        {/* A custom icon replaces the mark entirely rather than sitting inside
            it: most brand icons are full-colour, and tinting one with the
            accent fill would turn a logo into a silhouette. */}
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-control',
            branding.iconUrl === null && 'bg-accent text-accent-contrast',
          )}
        >
          {branding.iconUrl === null ? (
            <Route className="size-4" aria-hidden="true" />
          ) : (
            <img src={branding.iconUrl} alt="" className="size-full object-contain" />
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate font-head text-sm font-semibold tracking-tight text-text">
            {branding.name}
          </span>
          <span className="block truncate text-[0.6875rem] text-text-subtle">
            AI router &amp; gateway
          </span>
        </span>
      </Link>

      <SidebarNav className="scrollbar-none min-h-0 flex-1 overflow-y-auto px-2 pb-2" />

      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
        <button
          type="button"
          onClick={onOpenPalette}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-control px-2 text-xs text-text-subtle',
            'transition-colors duration-(--dur-micro) ease-out hover:bg-surface-2 hover:text-text',
          )}
        >
          <Search className="size-3.5" aria-hidden="true" />
          <span>Commands</span>
          <kbd className="ml-0.5 rounded-key border border-border bg-surface-2 px-1 text-[0.625rem] leading-4 text-text-muted">
            ⌘K
          </kbd>
        </button>
        <Badge tone="neutral" size="sm" dot>
          Local
        </Badge>
      </div>
    </div>
  );
}
