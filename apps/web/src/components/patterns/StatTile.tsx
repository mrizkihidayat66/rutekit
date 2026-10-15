import type { ReactNode } from 'react';

import { cn } from '@web/lib/cn.ts';

import { Meter, type MeterSize } from './Meter.tsx';
import { TONE_GRAPHIC, type Tone } from './tone.ts';

/**
 * One figure with its label, and whatever supports it.
 *
 * The Dashboard is a grid of these — memory, uptime, latency, pool size — and
 * the Usage page's summary strip is the same shape with a different value, so
 * the layout lives here once. The value is always a preformatted string: the
 * tile does not decide that `1.4 GiB` is right, `@web/lib/format` does, which
 * keeps every number in the console formatted the same way.
 */

export interface StatTileProps {
  readonly label: string;
  /** Already formatted — see `@web/lib/format`. */
  readonly value: string;
  /** Small trailing unit, e.g. `%` or `tok/s`, when it is not part of `value`. */
  readonly unit?: string;
  /** A muted line under the figure — a denominator, a state, a hint. */
  readonly detail?: ReactNode;
  /** A leading icon, coloured by `tone`. Pass it already `aria-hidden`. */
  readonly icon?: ReactNode;
  readonly tone?: Tone;
  /** `0..1` fill for the optional meter under the figure. */
  readonly meter?: number | null;
  readonly meterSize?: MeterSize;
  /** A slot below the figure — a sparkline, a badge row. */
  readonly footer?: ReactNode;
  readonly className?: string;
}

export function StatTile({
  label,
  value,
  unit,
  detail,
  icon,
  tone = 'neutral',
  meter,
  meterSize = 'sm',
  footer,
  className,
}: StatTileProps) {
  return (
    <div className={cn('card-surface flex flex-col gap-2 p-4', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-text-muted">{label}</span>
        {icon !== undefined ? (
          <span className={cn('shrink-0', TONE_GRAPHIC[tone])}>{icon}</span>
        ) : null}
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className="metric text-2xl leading-none text-text">{value}</span>
        {unit !== undefined ? <span className="text-xs text-text-subtle">{unit}</span> : null}
      </div>

      {meter !== undefined && meter !== null ? (
        <Meter value={meter} max={1} label={`${label} usage`} tone={tone} size={meterSize} />
      ) : null}

      {detail !== undefined ? <div className="text-xs text-text-muted">{detail}</div> : null}

      {footer !== undefined ? <div className="mt-auto pt-1">{footer}</div> : null}
    </div>
  );
}
