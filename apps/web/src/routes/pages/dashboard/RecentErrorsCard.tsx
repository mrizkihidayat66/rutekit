import { useState } from 'react';
import { Link } from 'react-router';

import type { RequestLog } from '@contracts';

import { DataTable, type DataTableColumn } from '@web/components/patterns/DataTable.tsx';
import {
  RequestInspectorDrawer,
  RequestSummary,
} from '@web/components/patterns/RequestInspectorDrawer.tsx';
import type { Tone } from '@web/components/patterns/tone.ts';
import { Badge } from '@web/components/ui/Badge.tsx';
import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { buttonVariants } from '@web/components/ui/button-variants.ts';
import { useRequestDetail } from '@web/hooks/use-overview.ts';
import { cn } from '@web/lib/cn.ts';
import { formatClock, formatDurationMs, formatUsd, statusBucket } from '@web/lib/format.ts';

/**
 * The failures, newest first, and the inspector that explains each one.
 *
 * This is the card an operator opens when something is wrong, so it is the one
 * place the full request inspector hangs off the Dashboard: a row opens the
 * drawer with the five payload panels, the route trace and the timing, without
 * a trip to another page.
 */

export interface RecentErrorsCardProps {
  readonly errors: readonly RequestLog[];
  readonly className?: string;
}

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
    id: 'latency',
    header: 'Latency',
    align: 'end',
    hideBelow: 'sm',
    cell: (row) => (
      <span className="tabular-nums text-text-muted">{formatDurationMs(row.latencyMs)}</span>
    ),
  },
  {
    id: 'cost',
    header: 'Cost',
    align: 'end',
    hideBelow: 'lg',
    cell: (row) => (
      <span className="tabular-nums text-text-muted">
        {row.costUsd === null ? '—' : formatUsd(row.costUsd)}
      </span>
    ),
  },
];

export function RecentErrorsCard({ errors, className }: RecentErrorsCardProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detail = useRequestDetail(selectedId);

  return (
    <>
      <Card flush className={cn('flex flex-col', className)}>
        <div className="px-4 pt-4 pb-3">
          <CardHeader
            title="Recent errors"
            description="The most recent failing requests. Open a row to see what the router sent and got back."
            actions={
              <Link to="/usage?outcome=errors" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                All requests
              </Link>
            }
          />
        </div>
        <div className="px-1 pb-2">
          <DataTable
            rows={errors}
            columns={COLUMNS}
            getRowId={(row) => row.id}
            caption="Recent failing requests"
            activeRowId={selectedId}
            onRowClick={(row) => {
              setSelectedId(row.id);
            }}
            emptyState={
              <StateView
                kind="empty"
                title="No failures"
                description="Nothing has failed in the captured window. That is the good outcome."
              />
            }
          />
        </div>
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
