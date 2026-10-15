import { RefreshCw } from 'lucide-react';

import type { TimeWindow, UsageBreakdownDimension, UsageBreakdownRow } from '@contracts';

import { BarList, type BarListItem } from '@web/components/patterns/BarList.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { SkeletonText } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatCount, formatRatio, formatTokens, formatUsd } from '@web/lib/format.ts';

import {
  DIMENSION_SELECT_OPTIONS,
  DIMENSIONS,
  WINDOW_PHRASE,
  breakdownTone,
  isDimension,
} from './metrics.ts';

/**
 * Where the requests went, by whatever the operator picks.
 *
 * One dimension at a time rather than five stacked lists: "which model costs the
 * most" and "which provider is failing" are different questions asked at
 * different moments, and a switcher keeps the card small enough to sit beside
 * the chart. The bars are ranked against the leader, so a long tail of
 * single-digit providers still reads as a shape rather than a flat row of
 * slivers.
 *
 * The list is capped: past a dozen rows a bar list stops being scannable, and
 * the count of what was left out is stated rather than quietly dropped.
 */

export interface BreakdownCardProps {
  readonly window: TimeWindow;
  readonly dimension: UsageBreakdownDimension;
  readonly onDimensionChange: (next: UsageBreakdownDimension) => void;
  readonly rows: readonly UsageBreakdownRow[];
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly onRetry: () => void;
  readonly className?: string;
}

/** Past this the list is a wall of bars, so it is trimmed and the rest counted. */
const TOP_N = 8;

export function BreakdownCard({
  window,
  dimension,
  onDimensionChange,
  rows,
  isPending,
  isError,
  onRetry,
  className,
}: BreakdownCardProps) {
  const dimensionLabel =
    DIMENSIONS.find((entry) => entry.key === dimension)?.label.toLowerCase() ?? dimension;

  const shown = rows.slice(0, TOP_N);
  const items: readonly BarListItem[] = shown.map((row) => ({
    key: row.key,
    label: row.label,
    value: formatCount(row.requests),
    share: row.share,
    tone: breakdownTone(dimension, row.key),
    hint: `${formatTokens(row.tokens)} tokens · ${formatUsd(row.costUsd)}`,
  }));

  const totals = rows.reduce(
    (sum, row) => ({
      requests: sum.requests + row.requests,
      tokens: sum.tokens + row.tokens,
      costUsd: sum.costUsd + row.costUsd,
    }),
    { requests: 0, tokens: 0, costUsd: 0 },
  );

  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader
        title="Breakdown"
        description={`Requests by ${dimensionLabel} over ${WINDOW_PHRASE[window]}.`}
        actions={
          <SimpleSelect
            value={dimension}
            onValueChange={(next) => {
              if (isDimension(next)) onDimensionChange(next);
            }}
            options={DIMENSION_SELECT_OPTIONS}
            size="sm"
            className="w-32"
            aria-label="Breakdown dimension"
          />
        }
      />

      {isPending ? (
        <SkeletonText lines={6} />
      ) : isError ? (
        <StateView
          kind="error"
          title="Could not load the breakdown"
          description="The console API did not answer. Check that the server is running, then try again."
          action={
            <Button variant="secondary" size="sm" onClick={onRetry}>
              <RefreshCw aria-hidden="true" className="size-3.5" />
              Retry
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <StateView
          kind="empty"
          title="Nothing to break down"
          description="No requests were recorded in this window, so there is nothing to rank."
        />
      ) : (
        <>
          <BarList items={items} />
          {rows.length > shown.length ? (
            <p className="mt-3 text-[0.6875rem] text-text-subtle">
              Showing the top {TOP_N} of {formatCount(rows.length)}.
            </p>
          ) : null}
          <dl className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border pt-3 text-xs">
            <div className="flex items-baseline gap-1.5">
              <dt className="text-text-subtle">Requests</dt>
              <dd className="font-medium tabular-nums text-text">{formatCount(totals.requests)}</dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-text-subtle">Tokens</dt>
              <dd className="font-medium tabular-nums text-text">{formatTokens(totals.tokens)}</dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-text-subtle">Cost</dt>
              <dd className="font-medium tabular-nums text-text">{formatUsd(totals.costUsd)}</dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-text-subtle">Leader</dt>
              <dd className="font-medium tabular-nums text-text">
                {formatRatio(rows[0]?.share ?? 0)}
              </dd>
            </div>
          </dl>
        </>
      )}
    </Card>
  );
}
