import { cn } from '@web/lib/cn.ts';
import type { CSSVars } from '@web/lib/css-vars.ts';

import { TONE_FILL, type Tone } from './tone.ts';

/**
 * A ranked list where each row carries a proportional bar.
 *
 * This is the shape a breakdown wants: "which provider spent the most" is a
 * comparison across a handful of named things, and a bar list reads that faster
 * than a pie (angles are hard to compare) and more compactly than a second
 * chart. Bars are scaled against the largest row, so the leader always fills
 * its track and the rest read as fractions of it.
 *
 * The bar is decorative — the value is right there as text — so it is hidden
 * from assistive technology rather than given a redundant label.
 */

export interface BarListItem {
  readonly key: string;
  readonly label: string;
  /** Already formatted, e.g. `1,204` or `$3.20`. */
  readonly value: string;
  /** `0..1` of the whole; only the *ratio* between rows is drawn. */
  readonly share: number;
  readonly tone?: Tone;
  /** A muted second line — a secondary figure or a caveat. */
  readonly hint?: string;
}

export interface BarListProps {
  readonly items: readonly BarListItem[];
  readonly className?: string;
}

export function BarList({ items, className }: BarListProps) {
  // Scale against the leader rather than against 1: a breakdown of thirty
  // providers is spread thin, and shares of a few percent would all but vanish.
  const peak = Math.max(0, ...items.map((item) => item.share)) || 1;

  return (
    <ul className={cn('space-y-2.5', className)}>
      {items.map((item) => {
        const width = Math.round(Math.min(1, Math.max(0, item.share / peak)) * 100);
        return (
          <li key={item.key}>
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="truncate text-text" title={item.label}>
                {item.label}
              </span>
              <span className="shrink-0 tabular-nums text-text-muted">{item.value}</span>
            </div>
            <div
              aria-hidden="true"
              className="mt-1 h-1.5 w-full overflow-hidden rounded-pill bg-surface-3"
            >
              <div
                className={cn(
                  'h-full w-(--bar-w) rounded-pill transition-[width] duration-(--dur-macro) ease-out',
                  TONE_FILL[item.tone ?? 'accent'],
                )}
                style={{ '--bar-w': `${width}%` } as CSSVars}
              />
            </div>
            {item.hint === undefined ? null : (
              <div className="mt-0.5 text-[0.6875rem] text-text-subtle">{item.hint}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
