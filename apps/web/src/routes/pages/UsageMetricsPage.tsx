import { RefreshCw } from 'lucide-react';

import type { TimeWindow, UsageBreakdownDimension } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { SegmentedControl } from '@web/components/ui/SegmentedControl.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import {
  useUsageBreakdown,
  useUsageSeries,
  useUsageSummary,
} from '@web/hooks/use-overview.ts';
import { useUrlParam } from '@web/hooks/use-url-state.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { BreakdownCard } from './usage/BreakdownCard.tsx';
import { RequestsCard } from './usage/RequestsCard.tsx';
import { SummaryStrip } from './usage/SummaryStrip.tsx';
import { UsageChartCard } from './usage/UsageChartCard.tsx';
import {
  DEFAULT_DIMENSION,
  DEFAULT_METRIC,
  DEFAULT_WINDOW,
  DIMENSION_KEYS,
  WINDOWS,
  WINDOW_LABELS,
  parseMetrics,
  toggleMetric,
} from './usage/metrics.ts';

/**
 * Usage & Metrics: what the router did, how much it cost, and where it went.
 *
 * The window is the page's one shared control — it drives the summary, the
 * chart, the breakdown and the request table at once — so it sits in the page
 * header and is written to the URL. The metric toggle and the breakdown
 * dimension belong to their own cards and live there, because a control should
 * sit inside the thing it changes.
 *
 * Each section owns its own loading, error and empty state, so a slow breakdown
 * never blanks the chart above it. The page holds no data of its own; the four
 * hooks below are the whole of it, and the request table fetches for itself.
 */

const WINDOW_OPTIONS = WINDOWS.map((entry) => ({ value: entry, label: WINDOW_LABELS[entry] }));

function SummarySkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading usage summary"
      className="grid grid-cols-1 gap-3 @[520px]:grid-cols-2 @[1000px]:grid-cols-4"
    >
      {Array.from({ length: 8 }, (_, index) => (
        <Card key={index} className="flex flex-col gap-3 p-4">
          <Skeleton shape="text" className="w-16" />
          <Skeleton shape="metric" />
          <Skeleton shape="text" className="w-2/3" />
        </Card>
      ))}
    </div>
  );
}

export function UsageMetricsPage() {
  const [window, setWindow] = useUrlParam<TimeWindow>('window', DEFAULT_WINDOW, WINDOWS);
  const [metricsRaw, setMetricsRaw] = useUrlParam<string>('metrics', DEFAULT_METRIC);
  const [dimension, setDimension] = useUrlParam<UsageBreakdownDimension>(
    'dimension',
    DEFAULT_DIMENSION,
    DIMENSION_KEYS,
  );

  const selected = parseMetrics(metricsRaw);

  const summary = useUsageSummary(window);
  const series = useUsageSeries(window);
  const breakdown = useUsageBreakdown(window, dimension);

  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="Usage & Metrics"
        description="What the router served, what it cost, and where it went."
        actions={
          <div className="max-w-full overflow-x-auto scrollbar-none">
            <SegmentedControl
              value={window}
              onValueChange={setWindow}
              aria-label="Time window"
              options={WINDOW_OPTIONS}
            />
          </div>
        }
      />

      <div className="@container flex flex-col gap-5">
        {summary.isPending ? (
          <SummarySkeleton />
        ) : summary.isError ? (
          <Card>
            <StateView
              kind="error"
              title="Could not load the summary"
              description="The console API did not answer. Check that the server is running, then try again."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  loading={summary.isFetching}
                  onClick={() => {
                    void summary.refetch();
                  }}
                >
                  <RefreshCw aria-hidden="true" className="size-3.5" />
                  Retry
                </Button>
              }
            />
          </Card>
        ) : (
          <SummaryStrip summary={summary.data} />
        )}

        <div className="grid grid-cols-1 gap-5 @[1024px]:grid-cols-3">
          <UsageChartCard
            window={window}
            points={series.data?.points ?? []}
            isPending={series.isPending}
            isError={series.isError}
            selected={selected}
            onToggle={(metric) => {
              setMetricsRaw(toggleMetric(selected, metric).join(','));
            }}
            onRetry={() => {
              void series.refetch();
            }}
            className="@[1024px]:col-span-2"
          />
          <BreakdownCard
            window={window}
            dimension={dimension}
            onDimensionChange={setDimension}
            rows={breakdown.data?.rows ?? []}
            isPending={breakdown.isPending}
            isError={breakdown.isError}
            onRetry={() => {
              void breakdown.refetch();
            }}
          />
        </div>

        <RequestsCard window={window} />
      </div>
    </div>
  );
}
