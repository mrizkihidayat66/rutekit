import type { BenchmarkRun } from '@contracts';

import { Card, CardBody, CardHeader } from '@web/components/ui/Card.tsx';
import { BarList, type BarListItem } from '@web/components/patterns/BarList.tsx';
import type { Tone } from '@web/components/patterns/tone.ts';
import { formatCount, formatDurationMs, formatPercent, formatTps } from '@web/lib/format.ts';

import { aggregateByTarget, targetLabel, type TargetAggregate } from './benchmark.ts';

/**
 * The comparison: each endpoint's averages, ranked.
 *
 * A benchmark compares named things, not a trend, so the chart is a set of
 * ranked bar lists rather than a time series — there is no axis to plot against.
 * Each metric gets its own list, and that is not decoration: time to first token
 * and total latency are different quantities in different units, and putting
 * them on one chart would invite exactly the comparison ADR-0017 forbids. Two
 * lists, two headings, two units, no shared scale.
 *
 * Each list is scaled against its own leader, so the shape of one says nothing
 * about the others. The figures beside the bars are what is comparable.
 */

function shareOf(values: readonly number[], value: number | null): number {
  if (value === null) return 0;
  const peak = Math.max(0, ...values.filter((entry) => Number.isFinite(entry)));
  return peak <= 0 ? 0 : Math.min(1, Math.max(0, value / peak));
}

interface Metric {
  readonly key: string;
  readonly title: string;
  readonly caption: string;
  readonly tone: Tone;
  readonly pick: (aggregate: TargetAggregate) => number | null;
  readonly format: (value: number) => string;
}

const METRICS: readonly Metric[] = [
  {
    key: 'quality',
    title: 'Quality',
    caption: 'Mean score across the variants this endpoint answered. Longer is better.',
    tone: 'success',
    pick: (aggregate) => aggregate.meanQuality,
    format: (value) => formatPercent(value * 100),
  },
  {
    key: 'throughput',
    title: 'Throughput',
    caption: 'Mean output tokens per second. Longer is better.',
    tone: 'accent',
    pick: (aggregate) => aggregate.meanTps,
    format: formatTps,
  },
  {
    key: 'ttft',
    title: 'Time to first token',
    caption:
      'How long each endpoint took to start answering. Shorter is faster, so the longest bar is the slowest endpoint.',
    tone: 'info',
    pick: (aggregate) => aggregate.meanTtftMs,
    format: formatDurationMs,
  },
  {
    key: 'latency',
    title: 'Total latency',
    caption:
      'How long each endpoint took to finish. A different measurement from the one above, on its own scale.',
    tone: 'warning',
    pick: (aggregate) => aggregate.meanLatencyMs,
    format: formatDurationMs,
  },
];

function itemsFor(aggregates: readonly TargetAggregate[], metric: Metric): readonly BarListItem[] {
  const values: number[] = [];
  for (const aggregate of aggregates) {
    const value = metric.pick(aggregate);
    if (value !== null) values.push(value);
  }

  return aggregates
    .map((aggregate) => {
      const value = metric.pick(aggregate);
      return {
        key: `${targetLabel(aggregate.target)}::${metric.key}`,
        label: targetLabel(aggregate.target),
        value: value === null ? '—' : metric.format(value),
        share: shareOf(values, value),
        tone: metric.tone,
        hint:
          aggregate.cells === 0
            ? 'No cells reported back'
            : `${formatCount(aggregate.succeeded)} of ${formatCount(aggregate.cells)} cells succeeded`,
      } satisfies BarListItem;
    })
    .sort((left, right) => right.share - left.share);
}

export interface BenchmarkComparisonProps {
  readonly run: BenchmarkRun;
}

export function BenchmarkComparison({ run }: BenchmarkComparisonProps) {
  if (run.results.length === 0) return null;

  const aggregates = aggregateByTarget(run.targets, run.results);

  return (
    <section className="@container flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold text-text">By endpoint</h2>
        <p className="mt-0.5 max-w-3xl text-xs text-text-muted">
          Each list is ranked within its own metric and scaled to its own leader, so a long bar in
          one says nothing about a long bar in another. Compare the figures, not the bar lengths
          across panels.
        </p>
      </div>

      <div className="grid gap-4 @[720px]:grid-cols-2">
        {METRICS.map((metric) => (
          <Card key={metric.key}>
            <CardHeader title={metric.title} description={metric.caption} />
            <CardBody>
              <BarList items={itemsFor(aggregates, metric)} />
            </CardBody>
          </Card>
        ))}
      </div>
    </section>
  );
}
