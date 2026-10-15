import { Check } from 'lucide-react';

import type { UsageMetric } from '@contracts';

import { TONE_CHIP, TONE_GRAPHIC } from '@web/components/patterns/tone.ts';
import { cn } from '@web/lib/cn.ts';

import { METRICS } from './metrics.ts';

/**
 * Which series the chart draws.
 *
 * Six switches rather than a legend, so the key and the control are the same
 * thing: the row doubles as the legend, and a metric that is off cannot be
 * confused with one that is merely flat. State is carried by the chip's fill and
 * a tick, not by its hue alone, so the on/off reading survives a colour-blind
 * operator and a greyscale screenshot (RULESET R4.7).
 */

export interface MetricToggleProps {
  readonly selected: readonly UsageMetric[];
  readonly onToggle: (metric: UsageMetric) => void;
  readonly className?: string;
}

export function MetricToggle({ selected, onToggle, className }: MetricToggleProps) {
  return (
    <div
      role="group"
      aria-label="Metrics shown in the chart"
      className={cn('flex flex-wrap items-center gap-1.5', className)}
    >
      {METRICS.map((metric) => {
        const active = selected.includes(metric.key);
        // The last metric cannot be turned off — a chart with no series is not a
        // chart, so the switch is disabled rather than silently ignored.
        const locked = active && selected.length === 1;
        return (
          <button
            key={metric.key}
            type="button"
            role="switch"
            aria-checked={active}
            disabled={locked}
            onClick={() => {
              onToggle(metric.key);
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs font-medium',
              'transition duration-(--dur-micro) ease-out outline-none',
              'focus-visible:ring-2 focus-visible:ring-focus',
              'disabled:cursor-not-allowed',
              active
                ? TONE_CHIP[metric.tone]
                : 'border-border bg-surface-2 text-text-subtle hover:border-border-strong hover:text-text-muted',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'size-1.5 shrink-0 rounded-pill',
                active ? 'bg-current' : cn('bg-current opacity-35', TONE_GRAPHIC[metric.tone]),
              )}
            />
            {metric.label}
            {active ? <Check aria-hidden="true" className="size-3" /> : null}
          </button>
        );
      })}
    </div>
  );
}
