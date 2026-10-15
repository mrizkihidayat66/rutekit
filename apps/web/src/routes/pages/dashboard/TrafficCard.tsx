import type { UsagePoint } from '@contracts';

import { AreaChart, ChartLegend, type ChartSeries } from '@web/components/patterns/AreaChart.tsx';
import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatCount, formatHour, formatRatio } from '@web/lib/format.ts';

/**
 * The hero chart: what the router did over the last day.
 *
 * Two series rather than one — requests and the errors inside them — because
 * "how busy" and "how well" are the two questions an operator opens the console
 * with, and a single line answers only the first. The totals under the legend
 * repeat what the plot shows at a glance, so the card is readable without
 * hovering anything.
 */

export interface TrafficCardProps {
  readonly traffic: readonly UsagePoint[];
  readonly className?: string;
}

export function TrafficCard({ traffic, className }: TrafficCardProps) {
  const requests = traffic.reduce((total, point) => total + point.requests, 0);
  const errors = traffic.reduce((total, point) => total + point.errors, 0);

  const series: readonly ChartSeries[] = [
    {
      key: 'requests',
      label: 'Requests',
      tone: 'accent',
      values: traffic.map((point) => point.requests),
    },
    {
      key: 'errors',
      label: 'Errors',
      tone: 'danger',
      values: traffic.map((point) => point.errors),
    },
  ];

  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader
        title="Traffic"
        description="Requests and the errors inside them, last 24 hours."
      />

      {traffic.length === 0 ? (
        <StateView
          kind="empty"
          title="No traffic yet"
          description="Once the router serves its first request, the last 24 hours appear here."
        />
      ) : (
        <>
          <AreaChart
            labels={traffic.map((point) => formatHour(point.at))}
            series={series}
            formatValue={formatCount}
            ariaLabel={`Requests and errors per hour over the last 24 hours: ${formatCount(requests)} requests, ${formatCount(errors)} errors.`}
            heightClassName="h-48"
          />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <ChartLegend series={series} />
            <dl className="flex items-center gap-4 text-xs">
              <div className="flex items-baseline gap-1.5">
                <dt className="text-text-subtle">Requests</dt>
                <dd className="font-medium tabular-nums text-text">{formatCount(requests)}</dd>
              </div>
              <div className="flex items-baseline gap-1.5">
                <dt className="text-text-subtle">Error rate</dt>
                <dd className="font-medium tabular-nums text-text">
                  {requests === 0 ? '—' : formatRatio(errors / requests)}
                </dd>
              </div>
            </dl>
          </div>
        </>
      )}
    </Card>
  );
}
