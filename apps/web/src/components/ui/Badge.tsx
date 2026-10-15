import type { ComponentPropsWithRef, ReactNode } from 'react';

import { cn } from '@web/lib/cn.ts';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning' | 'info';
export type BadgeSize = 'sm' | 'md';

// The tint stays on the fill token while the word uses the text token: a badge's
// background is a graphic and a badge's label is text, so the two want different
// contrast floors (NFR-6).
const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-2 text-text-muted border-border',
  accent: 'bg-accent/10 text-text border-accent/25',
  success: 'bg-success/12 text-success-text border-success/25',
  danger: 'bg-danger/12 text-danger-text border-danger/25',
  warning: 'bg-warning/14 text-warning-text border-warning/30',
  info: 'bg-info/12 text-info-text border-info/25',
};

const SIZES: Record<BadgeSize, string> = {
  sm: 'h-5 px-1.5 text-[0.6875rem]',
  md: 'h-6 px-2 text-xs',
};

export interface BadgeProps extends ComponentPropsWithRef<'span'> {
  tone?: BadgeTone;
  size?: BadgeSize;
  /** Small leading dot, used for live/health indicators. */
  dot?: boolean;
  /** Renders a leading dot that pulses — for "live" states only. */
  pulse?: boolean;
  icon?: ReactNode;
}

export function Badge({
  tone = 'neutral',
  size = 'md',
  dot = false,
  pulse = false,
  icon,
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-pill border font-medium tabular-nums',
        TONES[tone],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className={cn('size-1.5 rounded-pill bg-current', pulse && 'animate-pulse-soft')}
        />
      ) : null}
      {icon}
      {children}
    </span>
  );
}
