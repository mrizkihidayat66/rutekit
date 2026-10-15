import { useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';

import { cn } from '@web/lib/cn.ts';
import type { CSSVars } from '@web/lib/css-vars.ts';

import { TONE_GRAPHIC, type Tone } from './tone.ts';

/**
 * A multi-series area chart, drawn from the data rather than from a charting
 * library.
 *
 * There is no chart dependency on purpose: the console draws two shapes — a
 * time series and a breakdown — and a library would cost more bundle than the
 * whole of `app.css` (NFR-9) to render them. More importantly, a library brings
 * its own colours and its own DOM, and this one has to be re-themed from design
 * tokens and obey the same motion rules as everything else.
 *
 * The plot is a `viewBox` stretched to its box with `preserveAspectRatio="none"`,
 * and every stroke carries `vector-effect="non-scaling-stroke"` so it stays a
 * hairline at any width. Axis labels are HTML, not SVG text, so they never get
 * distorted by that stretch.
 *
 * It is keyboard-operable: focus the plot and the arrow keys walk the points,
 * Home/End jump to the ends, Escape clears the readout. The readout is a live
 * region, so the value under the cursor is announced rather than only shown.
 */

export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  readonly tone: Tone;
  /** One value per label, in the same order. */
  readonly values: readonly number[];
  /**
   * Overrides `formatValue` for this series' readout. A chart can mix a count
   * with a token total, and the readout must not print `45,120` for a cost.
   */
  readonly format?: (value: number) => string;
}

export interface AreaChartProps {
  readonly labels: readonly string[];
  /**
   * Overrides `labels` for the readout header. The axis wants a short tick — `14:00`
   * — while the readout wants to be unambiguous — `2026-10-11 14:00:00` — and a
   * bucket wider than an hour is only identified by the latter.
   */
  readonly readoutLabels?: readonly string[];
  readonly series: readonly ChartSeries[];
  /** Formats an axis tick and a readout value. */
  readonly formatValue: (value: number) => string;
  /** A sentence describing what the chart shows, for assistive technology. */
  readonly ariaLabel: string;
  /** Height of the plot area, as a Tailwind class. */
  readonly heightClassName?: string;
  readonly className?: string;
}

/** Grid lines minus one; four gaps gives five labels including zero. */
const TICK_GAPS = 4;
/** Above this the x labels collide, so they are sampled down. */
const MAX_X_LABELS = 6;

/**
 * Round a maximum up to a value a human would have picked, so the top grid line
 * reads `500` rather than `437.2`.
 */
function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function toX(index: number, count: number): number {
  return count <= 1 ? 0 : (index / (count - 1)) * 100;
}

function toY(value: number, max: number): number {
  return 100 - (value / max) * 100;
}

/** Evenly spaced label positions, always including both ends. */
function sampleIndices(count: number, maxLabels: number): number[] {
  if (count <= maxLabels) return Array.from({ length: count }, (_, index) => index);
  const stride = (count - 1) / (maxLabels - 1);
  const picked = new Set<number>();
  for (let step = 0; step < maxLabels; step += 1) {
    picked.add(Math.round(step * stride));
  }
  return [...picked].sort((a, b) => a - b);
}

export function AreaChart({
  labels,
  readoutLabels,
  series,
  formatValue,
  ariaLabel,
  heightClassName = 'h-56',
  className,
}: AreaChartProps) {
  const [active, setActive] = useState<number | null>(null);
  const pointCount = labels.length;

  const peak = Math.max(0, ...series.flatMap((entry) => entry.values));
  const max = niceMax(peak);
  const ticks = Array.from(
    { length: TICK_GAPS + 1 },
    (_, index) => (max / TICK_GAPS) * (TICK_GAPS - index),
  );
  const xIndices = sampleIndices(pointCount, MAX_X_LABELS);

  const paths = series.map((entry) => {
    const points = entry.values.map(
      (value, index) => `${toX(index, pointCount).toFixed(2)} ${toY(value, max).toFixed(2)}`,
    );
    const line = points.length === 0 ? '' : `M ${points.join(' L ')}`;
    return { key: entry.key, tone: entry.tone, line, area: `${line} L 100 100 L 0 100 Z` };
  });

  const handleMove = (event: MouseEvent<HTMLDivElement>) => {
    if (pointCount === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    setActive(Math.min(pointCount - 1, Math.max(0, Math.round(ratio * (pointCount - 1)))));
  };

  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (pointCount === 0) return;
    const current = active ?? pointCount - 1;
    if (event.key === 'ArrowLeft') setActive(Math.max(0, current - 1));
    else if (event.key === 'ArrowRight') setActive(Math.min(pointCount - 1, current + 1));
    else if (event.key === 'Home') setActive(0);
    else if (event.key === 'End') setActive(pointCount - 1);
    else if (event.key === 'Escape') setActive(null);
    else return;
    event.preventDefault();
  };

  // Keep the readout inside the plot: flush left at the first point, flush
  // right at the last, centred everywhere else.
  const tipShift = active === 0 ? '0%' : active === pointCount - 1 ? '-100%' : '-50%';

  return (
    <div className={cn('@container', className)}>
      <div className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-2">
        <div className={cn('relative', heightClassName)}>
          {ticks.map((tick, index) => (
            <span
              key={index}
              className="absolute right-1 top-(--tick-y) -translate-y-1/2 text-[0.625rem] tabular-nums text-text-subtle"
              style={{ '--tick-y': `${(index / TICK_GAPS) * 100}%` } as CSSVars}
            >
              {formatValue(tick)}
            </span>
          ))}
        </div>

        <div
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          onMouseMove={handleMove}
          onMouseLeave={() => {
            setActive(null);
          }}
          onKeyDown={handleKey}
          className={cn(
            'relative rounded-control outline-none focus-visible:ring-2 focus-visible:ring-focus',
            heightClassName,
          )}
        >
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
            className="absolute inset-0 h-full w-full"
          >
            <g className="text-border" strokeOpacity={0.6}>
              {ticks.map((_tick, index) => {
                const y = (index / TICK_GAPS) * 100;
                return (
                  <line
                    key={index}
                    x1={0}
                    x2={100}
                    y1={y}
                    y2={y}
                    stroke="currentColor"
                    strokeWidth={1}
                    strokeDasharray="2 3"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
            </g>

            {paths.map((path) => (
              <g key={path.key} className={TONE_GRAPHIC[path.tone]}>
                {path.line === '' ? null : (
                  <>
                    <path d={path.area} fill="currentColor" fillOpacity={0.12} />
                    <path
                      d={path.line}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  </>
                )}
              </g>
            ))}

            {active === null ? null : (
              <line
                x1={toX(active, pointCount)}
                x2={toX(active, pointCount)}
                y1={0}
                y2={100}
                className="text-text-subtle"
                stroke="currentColor"
                strokeWidth={1}
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          {active === null ? null : (
            <div
              role="status"
              aria-live="polite"
              className="pointer-events-none absolute top-2 left-(--tip-x) z-10 min-w-max translate-x-(--tip-shift) rounded-control border border-border bg-surface-3 px-2 py-1.5 shadow-popover"
              style={
                { '--tip-x': `${toX(active, pointCount)}%`, '--tip-shift': tipShift } as CSSVars
              }
            >
              <div className="text-[0.6875rem] font-medium text-text-muted">
                {(readoutLabels ?? labels)[active] ?? ''}
              </div>
              <ul className="mt-1 space-y-0.5">
                {series.map((entry) => (
                  <li key={entry.key} className="flex items-center gap-2 text-xs">
                    <span
                      aria-hidden="true"
                      className={cn('size-1.5 shrink-0 rounded-pill bg-current', TONE_GRAPHIC[entry.tone])}
                    />
                    <span className="text-text-muted">{entry.label}</span>
                    <span className="ml-3 font-medium tabular-nums text-text">
                      {(entry.format ?? formatValue)(entry.values[active] ?? 0)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      <div className="mt-1.5 grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-2">
        <div />
        <div className="flex justify-between text-[0.625rem] tabular-nums text-text-subtle">
          {xIndices.map((index) => (
            <span key={index}>{labels[index] ?? ''}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

export interface ChartLegendProps {
  readonly series: readonly ChartSeries[];
  readonly className?: string;
}

export function ChartLegend({ series, className }: ChartLegendProps) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1', className)}>
      {series.map((entry) => (
        <li key={entry.key} className="flex items-center gap-1.5 text-xs text-text-muted">
          <span
            aria-hidden="true"
            className={cn('size-2 rounded-pill bg-current', TONE_GRAPHIC[entry.tone])}
          />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}
