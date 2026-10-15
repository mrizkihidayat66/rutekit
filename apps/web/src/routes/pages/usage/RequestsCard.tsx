import { RefreshCw } from 'lucide-react';
import { useState } from 'react';

import type { RequestLog, RequestsQuery, SortDirection, TimeWindow } from '@contracts';

import { DataTable, type DataTableColumn, type SortState } from '@web/components/patterns/DataTable.tsx';
import {
  RequestInspectorDrawer,
  RequestSummary,
} from '@web/components/patterns/RequestInspectorDrawer.tsx';
import type { Tone } from '@web/components/patterns/tone.ts';
import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import { SegmentedControl } from '@web/components/ui/SegmentedControl.tsx';
import { SkeletonText } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useRequestDetail, useRequests } from '@web/hooks/use-overview.ts';
import { useUrlParam } from '@web/hooks/use-url-state.ts';
import { cn } from '@web/lib/cn.ts';
import { formatClock, formatCount, formatDurationMs, formatUsd, statusBucket } from '@web/lib/format.ts';

import { OUTCOMES, OUTCOME_LABELS, WINDOW_PHRASE, type Outcome } from './metrics.ts';

/**
 * Every request the router served, and the inspector that opens on a row.
 *
 * This is the table the Dashboard's error panel links into, so the outcome
 * filter is read straight from the URL — `?outcome=errors` arrives here already
 * applied rather than needing a click. Sort, filter and window are all
 * bookmarkable for the same reason (RULESET R6.5): an operator pasting a URL
 * into a chat means the same view, not the same page.
 *
 * Paging is cursor-based and appends, because the log grows at the head: an
 * offset page would skip or repeat rows as new requests land.
 */

export interface RequestsCardProps {
  readonly window: TimeWindow;
  readonly className?: string;
}

/** Matches the contract's own page default. */
const PAGE_SIZE = 50;

const BUCKET_TONE: Record<ReturnType<typeof statusBucket>, Tone> = {
  success: 'success',
  redirect: 'info',
  client: 'warning',
  server: 'danger',
};

const COLUMNS: readonly DataTableColumn<RequestLog>[] = [
  {
    id: 'at',
    header: 'Time',
    sortKey: 'at',
    widthClassName: 'w-20',
    cell: (row) => <span className="tabular-nums text-text-muted">{formatClock(row.at)}</span>,
  },
  {
    id: 'request',
    header: 'Request',
    cell: (row) => (
      <span className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-[0.6875rem] text-text-subtle">{row.method}</span>
        <span className="truncate font-mono text-xs text-text">{row.path}</span>
      </span>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    sortKey: 'status',
    cell: (row) => (
      <Badge tone={BUCKET_TONE[statusBucket(row.status)]} size="sm">
        {row.status}
      </Badge>
    ),
  },
  {
    id: 'provider',
    header: 'Provider',
    hideBelow: 'sm',
    cell: (row) => <span className="text-xs text-text-muted">{row.providerId ?? '—'}</span>,
  },
  {
    id: 'model',
    header: 'Model',
    hideBelow: 'md',
    cell: (row) => <span className="truncate text-xs text-text-muted">{row.model ?? '—'}</span>,
  },
  {
    id: 'tokens',
    header: 'Tokens',
    align: 'end',
    hideBelow: 'md',
    cell: (row) => (
      <span className="tabular-nums text-text-muted">
        {row.inputTokens === null && row.outputTokens === null
          ? '—'
          : `${formatCount(row.inputTokens ?? 0)} / ${formatCount(row.outputTokens ?? 0)}`}
      </span>
    ),
  },
  {
    id: 'latency',
    header: 'Latency',
    sortKey: 'latencyMs',
    align: 'end',
    hideBelow: 'sm',
    cell: (row) => (
      <span className="tabular-nums text-text-muted">{formatDurationMs(row.latencyMs)}</span>
    ),
  },
  {
    id: 'cost',
    header: 'Cost',
    sortKey: 'costUsd',
    align: 'end',
    hideBelow: 'lg',
    cell: (row) => (
      <span className="tabular-nums text-text-muted">
        {row.costUsd === null ? '—' : formatUsd(row.costUsd)}
      </span>
    ),
  },
];

export function RequestsCard({ window, className }: RequestsCardProps) {
  const [outcome, setOutcome] = useUrlParam<Outcome>('outcome', 'all', OUTCOMES);
  const [sortKey, setSortKey] = useUrlParam<string>('sort', 'at');
  const [direction, setDirection] = useUrlParam<SortDirection>('dir', 'desc', ['asc', 'desc']);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const query: Omit<RequestsQuery, 'cursor'> = {
    window,
    providerId: null,
    model: null,
    apiKeyId: null,
    outcome,
    sort: sortKey,
    direction,
    limit: PAGE_SIZE,
  };

  const requests = useRequests(query);
  const detail = useRequestDetail(selectedId);

  const pages = requests.data?.pages ?? [];
  const rows = pages.flatMap((page) => page.items);
  const total = pages[0]?.total ?? 0;
  const firstLoad = requests.isPending;
  const sort: SortState = { key: sortKey, direction };

  const footer =
    rows.length === 0 ? undefined : (
      <div className="flex items-center justify-between gap-3 text-xs text-text-muted">
        <span className="tabular-nums">
          Showing {formatCount(rows.length)} of {formatCount(total)}
        </span>
        {requests.hasNextPage ? (
          <Button
            variant="secondary"
            size="sm"
            loading={requests.isFetchingNextPage}
            onClick={() => {
              void requests.fetchNextPage();
            }}
          >
            Load more
          </Button>
        ) : null}
      </div>
    );

  return (
    <>
      <Card flush className={cn('flex flex-col', className)}>
        <div className="px-4 pt-4 pb-3">
          <CardHeader
            title="Requests"
            description={`Every request the router served over ${WINDOW_PHRASE[window]}. Open a row to see what it sent and got back.`}
            actions={
              <SegmentedControl
                value={outcome}
                onValueChange={setOutcome}
                aria-label="Filter by outcome"
                options={OUTCOMES.map((entry) => ({ value: entry, label: OUTCOME_LABELS[entry] }))}
              />
            }
          />
        </div>

        {firstLoad ? (
          <div className="px-4 pb-4" role="status" aria-live="polite" aria-label="Loading requests">
            <SkeletonText lines={8} />
          </div>
        ) : requests.isError ? (
          <StateView
            kind="error"
            title="Could not load the request log"
            description="The console API did not answer. Check that the server is running, then try again."
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void requests.refetch();
                }}
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
                Retry
              </Button>
            }
          />
        ) : (
          <div className="px-1 pb-2">
            <DataTable
              rows={rows}
              columns={COLUMNS}
              getRowId={(row) => row.id}
              caption="Requests served by the router"
              sort={sort}
              onSortChange={(next) => {
                setSortKey(next.key ?? 'at');
                setDirection(next.direction);
              }}
              activeRowId={selectedId}
              onRowClick={(row) => {
                setSelectedId(row.id);
              }}
              emptyState={
                <StateView
                  kind={outcome === 'all' ? 'empty' : 'no-results'}
                  title={outcome === 'errors' ? 'No failures' : 'No requests'}
                  description={
                    outcome === 'errors'
                      ? 'Nothing failed in this window. That is the good outcome.'
                      : 'No requests were recorded in this window. Widen it, or wait for traffic.'
                  }
                />
              }
              footer={footer}
            />
          </div>
        )}
      </Card>

      <RequestInspectorDrawer
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        detail={detail.data ?? null}
        isLoading={detail.isLoading}
        isError={detail.isError}
      >
        {detail.data === undefined ? null : <RequestSummary request={detail.data.request} />}
      </RequestInspectorDrawer>
    </>
  );
}
