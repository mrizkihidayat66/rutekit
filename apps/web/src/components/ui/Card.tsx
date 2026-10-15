import type { ComponentPropsWithRef, ReactNode } from 'react';

import { cn } from '@web/lib/cn.ts';

export interface CardProps extends ComponentPropsWithRef<'div'> {
  /** `raised` lifts onto surface-3 with a stronger shadow (popovers, palettes). */
  elevation?: 'flat' | 'raised';
  /** Removes the padding so a table or list can sit flush to the edges. */
  flush?: boolean;
}

export function Card({ elevation = 'flat', flush = false, className, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'card-surface',
        elevation === 'raised' && 'bg-surface-3 shadow-popover',
        !flush && 'p-4',
        className,
      )}
      {...props}
    />
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned controls: filters, actions, segmented switches. */
  actions?: ReactNode;
  className?: string;
}

export function CardHeader({ title, description, actions, className }: CardHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-4 pb-3', className)}>
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-text">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs text-text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div className={cn('text-sm text-text', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return (
    <div
      className={cn('mt-3 flex items-center justify-end gap-2 border-t border-border pt-3', className)}
      {...props}
    />
  );
}
