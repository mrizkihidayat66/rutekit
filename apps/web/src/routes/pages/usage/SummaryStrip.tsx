import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleCheck,
  CircleDollarSign,
  Database,
  Gauge,
  Zap,
} from 'lucide-react';

import type { UsageSummary } from '@contracts';

import { StatTile } from '@web/components/patterns/StatTile.tsx';
import {
  formatCount,
  formatDurationMs,
  formatRatio,
  formatTokens,
  formatTps,
  formatUsd,
} from '@web/lib/format.ts';

import { WINDOW_PHRASE, successRateTone } from './metrics.ts';

/**
 * The figures behind the chart.
 *
 * The chart says *when*; these say *how much*, and the two are read together, so
 * the strip sits directly above the plot and repeats the same window. Each
 * tile's colour matches the series of the same name in the chart, so the eye
 * pairs `Input tokens` here with the info-blue line above it without a legend.
 *
 * Every derived figure guards its own denominator: a window with no traffic is a
 * real state (a quiet instance, a fresh one) and must read as `—`, never as
 * `NaN%` or a division by zero.
 */

export interface SummaryStripProps {
  readonly summary: UsageSummary;
  readonly className?: string;
}

export function SummaryStrip({ summary, className }: SummaryStripProps) {
  const { requests, successRate } = summary;
  const failed = Math.round(requests * (1 - successRate));
  const succeeded = requests - failed;
  const totalTokens = summary.inputTokens + summary.outputTokens;
  const share = (part: number): string =>
    totalTokens === 0 ? '—' : formatRatio(part / totalTokens);

  return (
    <div
      role="group"
      aria-label={`Usage summary for ${WINDOW_PHRASE[summary.window]}`}
      className={className}
    >
      <div className="@container">
        <div className="grid grid-cols-1 gap-3 @[520px]:grid-cols-2 @[1000px]:grid-cols-4">
          <StatTile
            label="Requests"
            value={formatCount(requests)}
            icon={<Activity className="size-4" aria-hidden="true" />}
            tone="accent"
            detail={WINDOW_PHRASE[summary.window]}
          />
          <StatTile
            label="Success rate"
            value={formatRatio(successRate, 1)}
            icon={<CircleCheck className="size-4" aria-hidden="true" />}
            tone={successRateTone(successRate)}
            meter={successRate}
            detail={failed === 0 ? 'No failures' : `${formatCount(failed)} failed`}
          />
          <StatTile
            label="Input tokens"
            value={formatTokens(summary.inputTokens)}
            icon={<ArrowDownToLine className="size-4" aria-hidden="true" />}
            tone="info"
            detail={`${share(summary.inputTokens)} of tokens`}
          />
          <StatTile
            label="Output tokens"
            value={formatTokens(summary.outputTokens)}
            icon={<ArrowUpFromLine className="size-4" aria-hidden="true" />}
            tone="success"
            detail={`${share(summary.outputTokens)} of tokens`}
          />
          <StatTile
            label="Cached tokens"
            value={formatTokens(summary.cachedInputTokens)}
            icon={<Database className="size-4" aria-hidden="true" />}
            tone="warning"
            detail={
              summary.inputTokens === 0
                ? 'No input to cache'
                : `${formatRatio(summary.cachedInputTokens / summary.inputTokens)} of input`
            }
          />
          <StatTile
            label="Cost"
            value={formatUsd(summary.costUsd)}
            icon={<CircleDollarSign className="size-4" aria-hidden="true" />}
            detail={
              requests === 0 ? 'No spend yet' : `${formatUsd(summary.costUsd / requests)} per request`
            }
          />
          <StatTile
            label="Latency"
            value={summary.avgLatencyMs === null ? '—' : formatDurationMs(summary.avgLatencyMs)}
            icon={<Gauge className="size-4" aria-hidden="true" />}
            detail={
              summary.avgTtftMs === null ? 'No streamed requests' : `TTFT ${formatDurationMs(summary.avgTtftMs)}`
            }
          />
          <StatTile
            label="Throughput"
            value={
              summary.avgTokensPerSecond === null ? '—' : formatTps(summary.avgTokensPerSecond)
            }
            icon={<Zap className="size-4" aria-hidden="true" />}
            detail={
              succeeded === 0 ? 'No completed streams' : `Across ${formatCount(succeeded)} streams`
            }
          />
        </div>
      </div>
    </div>
  );
}
