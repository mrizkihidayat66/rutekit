import type { ReactNode } from 'react';

import { cn } from '@web/lib/cn.ts';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned controls: filters, segmented switches, primary actions. */
  actions?: ReactNode;
  className?: string;
}

/**
 * The title block every page opens with. The topbar names the view like a
 * window title; this is the page's own heading and the place its controls live.
 */
export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-3 pb-4', className)}>
      <div className="min-w-0">
        <h1 className="font-head text-lg font-semibold tracking-tight text-text">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-xs text-text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
