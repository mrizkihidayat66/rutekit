import { RefreshCw } from 'lucide-react';

import type { TimeWindow, UsageMetric, UsagePoint } from '@contracts';

import { AreaChart } from '@web/components/patterns/AreaChart.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatCompact, formatDateTime, formatDay, formatHour } from '@web/lib/format.ts';

import { MetricToggle } from './MetricToggle.tsx';
import { WINDOW_PHRASE, describeMetrics, metricByKey, toChartSeries } from './metrics.ts';

/**
 * The page's hero: the metric series over the chosen window.
 *
 * The metric toggle sits inside the card rather than in the page header because
 * it only governs this plot — the window above it governs the whole page, and
 * mixing the two scopes in one toolbar is how a control ends up looking like it
 * does something it does not.
 *
 * A bucket wider than an hour is labelled by its date on the axis (the same
 * `06:00` four times over is not a label) but by its full timestamp in the
 * readout, where there is room to be exact.
 */

export interface UsageChartCardProps {
  readonly window: TimeWindow;
  readonly points: readonly UsagePoint[];
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly selected: readonly UsageMetric[];
  readonly onToggle: (metric: UsageMetric) => void;
  readonly onRetry: () => void;
  readonly className?: string;
}

/** Buckets this wide are still identified by their clock time. */
const SUB_DAY: readonly TimeWindow[] = ['1h', '6h', '12h', '24h'];

export function UsageChartCard({
  window,
  points,
  isPending,
  isError,
  selected,
  onToggle,
  onRetry,
  className,
}: UsageChartCardProps) {
  const subDay = SUB_DAY.includes(window);
  const axisLabel = subDay ? formatHour : formatDay;
  const readoutLabel = subDay ? formatHour : formatDateTime;

  const series = selected.map((key) => toChartSeries(metricByKey(key), points));
  const totals = selected.map((key) => {
    const metric = metricByKey(key);
    const total = points.reduce((sum, point) => sum + metric.value(point), 0);
    return { key: metric.key, label: metric.label, formatted: metric.format(total) };
  });

  const summary = describeMetrics(selected);

  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader
        title="Activity"
        description={`${summary.charAt(0).toUpperCase()}${summary.slice(1)} over ${WINDOW_PHRASE[window]}.`}
      />

      <MetricToggle selected={selected} onToggle={onToggle} className="pb-4" />

      {isPending ? (
        <Skeleton className="h-56 w-full" />
      ) : isError ? (
        <StateView
          kind="error"
          title="Could not load the series"
          description="The console API did not answer. Check that the server is running, then try again."
          action={
            <Button variant="secondary" size="sm" onClick={onRetry}>
              <RefreshCw aria-hidden="true" className="size-3.5" />
              Retry
            </Button>
          }
        />
      ) : points.length === 0 ? (
        <StateView
          kind="empty"
          title="No traffic in this window"
          description="Widen the window, or wait for the router to serve its first request."
        />
      ) : (
        <>
          <AreaChart
            labels={points.map((point) => axisLabel(point.at))}
            readoutLabels={points.map((point) => readoutLabel(point.at))}
            series={series}
            formatValue={formatCompact}
            ariaLabel={`${summary} over ${WINDOW_PHRASE[window]}: ${totals
              .map((entry) => `${entry.label} ${entry.formatted}`)
              .join(', ')}.`}
            heightClassName="h-56"
          />

          <dl className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-3 text-xs">
            {totals.map((entry) => (
              <div key={entry.key} className="flex items-baseline gap-1.5">
                <dt className="text-text-subtle">{entry.label}</dt>
                <dd className="font-medium tabular-nums text-text">{entry.formatted}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </Card>
  );
}
