import { useState } from 'react';

import type { BenchmarkResult, BenchmarkRun, SortDirection } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { DataTable, type DataTableColumn, type SortState } from '@web/components/patterns/DataTable.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatCount, formatDurationMs, formatPercent, formatTps, formatUsd } from '@web/lib/format.ts';

import { BenchmarkCellDrawer } from './BenchmarkCellDrawer.tsx';
import { RUN_STATUS_LABELS, RUN_STATUS_TONES, targetLabel, variantLabels } from './benchmark.ts';

/**
 * Every cell of the run, one row each.
 *
 * The matrix is stored flat — one row per variant × endpoint — and it is shown
 * flat too, because that is the shape a person reads: "which endpoint answered
 * this variant well" is a question about a row, and the alternative, a grid of
 * endpoint columns, multiplies the metrics across the width and pushes the
 * answer off the screen.
 *
 * Time to first token and total latency are two columns with two names. They are
 * different measurements of different things — how long the endpoint took to
 * start, and how long it took to finish — and averaging them together, or
 * printing one under the other's heading, is the mistake this table exists to
 * avoid (ADR-0017).
 *
 * Sorting is local rather than through the API: the whole run arrives in one
 * response, so re-ordering it is a rearrangement of what is already on the
 * screen, and a round trip would only add latency to a click.
 */

type SortField =
  | 'variant'
  | 'endpoint'
  | 'status'
  | 'ttftMs'
  | 'latencyMs'
  | 'tokensPerSecond'
  | 'costUsd'
  | 'qualityScore';

function sortValue(
  row: BenchmarkResult,
  field: SortField,
  labels: ReadonlyMap<string, string>,
): number | string | null {
  switch (field) {
    case 'variant':
      return labels.get(row.variantId) ?? row.variantId;
    case 'endpoint':
      return targetLabel(row);
    case 'status':
      return row.status;
    case 'ttftMs':
      return row.ttftMs;
    case 'latencyMs':
      return row.latencyMs;
    case 'tokensPerSecond':
      return row.tokensPerSecond;
    case 'costUsd':
      return row.costUsd;
    case 'qualityScore':
      return row.qualityScore;
  }
}

function compare(
  left: BenchmarkResult,
  right: BenchmarkResult,
  field: SortField,
  direction: SortDirection,
  labels: ReadonlyMap<string, string>,
): number {
  const a = sortValue(left, field, labels);
  const b = sortValue(right, field, labels);

  // A cell with no figure sorts last whichever way the column points. It is an
  // absence, not a small number, and letting it sort as zero would put the one
  // endpoint that never answered at the top of a "fastest" list.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  const order =
    typeof a === 'number' && typeof b === 'number' ? a - b : `${a}`.localeCompare(`${b}`);
  return direction === 'asc' ? order : -order;
}

const FIELD_FOR_KEY: Record<string, SortField> = {
  variant: 'variant',
  endpoint: 'endpoint',
  status: 'status',
  ttftMs: 'ttftMs',
  latencyMs: 'latencyMs',
  tokensPerSecond: 'tokensPerSecond',
  costUsd: 'costUsd',
  qualityScore: 'qualityScore',
};

function figure(value: number | null, format: (input: number) => string): string {
  return value === null ? '—' : format(value);
}

export interface BenchmarkResultsProps {
  readonly run: BenchmarkRun;
}

export function BenchmarkResults({ run }: BenchmarkResultsProps) {
  const [sort, setSort] = useState<SortState>({ key: 'variant', direction: 'asc' });
  const [selected, setSelected] = useState<BenchmarkResult | null>(null);

  const labels = variantLabels(run);
  const field: SortField | null =
    sort.key === null ? null : (FIELD_FOR_KEY[sort.key] ?? null);

  const rows =
    field === null
      ? run.results
      : [...run.results].sort((left, right) => compare(left, right, field, sort.direction, labels));

  const columns: readonly DataTableColumn<BenchmarkResult>[] = [
    {
      id: 'variant',
      header: 'Variant',
      sortKey: 'variant',
      cell: (row) => (
        <span className="block max-w-56 truncate text-text" title={labels.get(row.variantId)}>
          {labels.get(row.variantId) ?? row.variantId}
        </span>
      ),
    },
    {
      id: 'endpoint',
      header: 'Endpoint',
      sortKey: 'endpoint',
      cell: (row) => (
        <span className="block max-w-56 truncate font-mono text-xs text-text-muted" title={targetLabel(row)}>
          {targetLabel(row)}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortKey: 'status',
      widthClassName: 'w-28',
      cell: (row) => (
        <Badge tone={RUN_STATUS_TONES[row.status]} size="sm">
          {RUN_STATUS_LABELS[row.status]}
        </Badge>
      ),
    },
    {
      id: 'ttft',
      header: 'TTFT',
      sortKey: 'ttftMs',
      align: 'end',
      widthClassName: 'w-24',
      cell: (row) => (
        <span className={cn('tabular-nums', row.ttftMs === null && 'text-text-subtle')}>
          {figure(row.ttftMs, formatDurationMs)}
        </span>
      ),
    },
    {
      id: 'latency',
      header: 'Total',
      sortKey: 'latencyMs',
      align: 'end',
      widthClassName: 'w-24',
      hideBelow: 'sm',
      cell: (row) => (
        <span className={cn('tabular-nums', row.latencyMs === null && 'text-text-subtle')}>
          {figure(row.latencyMs, formatDurationMs)}
        </span>
      ),
    },
    {
      id: 'throughput',
      header: 'Throughput',
      sortKey: 'tokensPerSecond',
      align: 'end',
      widthClassName: 'w-28',
      hideBelow: 'sm',
      cell: (row) => (
        <span className={cn('tabular-nums', row.tokensPerSecond === null && 'text-text-subtle')}>
          {figure(row.tokensPerSecond, formatTps)}
        </span>
      ),
    },
    {
      id: 'cost',
      header: 'Cost',
      sortKey: 'costUsd',
      align: 'end',
      widthClassName: 'w-24',
      hideBelow: 'md',
      cell: (row) => (
        <span className={cn('tabular-nums', row.costUsd === null && 'text-text-subtle')}>
          {figure(row.costUsd, formatUsd)}
        </span>
      ),
    },
    {
      id: 'quality',
      header: 'Quality',
      sortKey: 'qualityScore',
      align: 'end',
      widthClassName: 'w-24',
      hideBelow: 'md',
      cell: (row) => (
        <span className={cn('tabular-nums', row.qualityScore === null && 'text-text-subtle')}>
          {figure(row.qualityScore, (value) => formatPercent(value * 100))}
        </span>
      ),
    },
  ];

  return (
    <Card flush>
      <div className="flex flex-col gap-1 p-4 pb-3">
        <h2 className="text-sm font-semibold text-text">Cells</h2>
        <p className="max-w-3xl text-xs text-text-muted">
          <span className="font-medium text-text-subtle">TTFT</span> is how long the endpoint took to
          start answering and{' '}
          <span className="font-medium text-text-subtle">Total</span> is how long the whole response
          took. They measure different things, so they are kept apart rather than averaged together.
          Open a row to read the output.
        </p>
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        caption="Benchmark results by variant and endpoint"
        sort={sort}
        onSortChange={setSort}
        activeRowId={selected?.id ?? null}
        onRowClick={(row) => {
          setSelected(row);
        }}
        emptyState={
          <StateView
            kind="empty"
            title="No cells yet"
            description="The run has been queued and its endpoints have not reported back. The table fills in as they do."
          />
        }
        footer={
          <p className="text-xs tabular-nums text-text-subtle">
            {formatCount(rows.length)} of {formatCount(run.expectedResultCount)} cells
          </p>
        }
      />

      <BenchmarkCellDrawer
        result={selected}
        variantLabel={selected === null ? '' : (labels.get(selected.variantId) ?? selected.variantId)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      />
    </Card>
  );
}
