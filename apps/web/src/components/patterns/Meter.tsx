import { cn } from '@web/lib/cn.ts';
import type { CSSVars } from '@web/lib/css-vars.ts';

import { TONE_FILL, type Tone } from './tone.ts';

/**
 * A single-value meter — how full one thing is.
 *
 * Used wherever a quantity has a known ceiling: a credit pool's spend, an API
 * key's budget, memory against total. The same bar also serves as a progress
 * bar for work in flight — the Studio's generation queue — which is why the
 * ARIA role is the caller's to choose. `role="meter"` with a real
 * `aria-valuenow` is what lets a screen reader read the figure without the
 * label being repeated in text.
 */

export type MeterSize = 'sm' | 'md';

/**
 * `meter` is a static ratio; `progressbar` is work in flight. They look the same
 * and mean different things, so the caller says which one it is rather than the
 * component guessing from the value.
 */
export type MeterRole = 'meter' | 'progressbar';

export interface MeterProps {
  readonly value: number;
  readonly max: number;
  /** What the meter measures — becomes the accessible name. */
  readonly label: string;
  readonly tone?: Tone;
  readonly size?: MeterSize;
  readonly role?: MeterRole;
  readonly className?: string;
}

const SIZES: Record<MeterSize, string> = {
  sm: 'h-1',
  md: 'h-1.5',
};

export function Meter({
  value,
  max,
  label,
  tone = 'accent',
  size = 'md',
  role = 'meter',
  className,
}: MeterProps) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const percent = Math.round(ratio * 100);

  // The fill's width comes from `w-(--meter-fill)` reading the one inline
  // custom property below — the only inline style, which is what the
  // no-inline-style rule permits.
  return (
    <div
      role={role}
      aria-label={label}
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${percent}%`}
      className={cn('w-full overflow-hidden rounded-pill bg-surface-3', SIZES[size], className)}
    >
      <div
        className={cn(
          'h-full w-(--meter-fill) rounded-pill transition-[width] duration-(--dur-macro) ease-out',
          TONE_FILL[tone],
        )}
        style={{ '--meter-fill': `${percent}%` } as CSSVars}
      />
    </div>
  );
}
