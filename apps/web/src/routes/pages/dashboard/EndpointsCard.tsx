import type { EndpointStatus } from '@contracts';

import { DataTable, type DataTableColumn } from '@web/components/patterns/DataTable.tsx';
import { Badge } from '@web/components/ui/Badge.tsx';
import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatCount, formatDurationMs } from '@web/lib/format.ts';

/**
 * The API surfaces the router exposes, and how each is doing.
 *
 * `enabled` is shown rather than filtered on: a disabled surface is a fact the
 * operator set and needs to see reflected, not an absence — `completions` sits
 * in the list switched off, which is exactly the reassurance the card is for.
 */

export interface EndpointsCardProps {
  readonly endpoints: readonly EndpointStatus[];
  readonly className?: string;
}

const COLUMNS: readonly DataTableColumn<EndpointStatus>[] = [
  {
    id: 'surface',
    header: 'Surface',
    cell: (row) => <span className="font-mono text-xs text-text">/v1/{row.surface}</span>,
  },
  {
    id: 'state',
    header: 'State',
    cell: (row) => (
      <Badge tone={row.enabled ? 'success' : 'neutral'} size="sm" dot>
        {row.enabled ? 'enabled' : 'disabled'}
      </Badge>
    ),
  },
  {
    id: 'requests',
    header: 'Requests',
    align: 'end',
    hideBelow: 'sm',
    cell: (row) => <span className="tabular-nums text-text-muted">{formatCount(row.requestsLastHour)}</span>,
  },
  {
    id: 'errors',
    header: 'Errors',
    align: 'end',
    hideBelow: 'sm',
    cell: (row) => (
      <span className={cn('tabular-nums', row.errorsLastHour === 0 ? 'text-text-subtle' : 'text-warning-text')}>
        {formatCount(row.errorsLastHour)}
      </span>
    ),
  },
  {
    id: 'latency',
    header: 'Latency',
    align: 'end',
    hideBelow: 'md',
    cell: (row) => (
      <span className="tabular-nums text-text-muted">
        {row.avgLatencyMs === null ? '—' : formatDurationMs(row.avgLatencyMs)}
      </span>
    ),
  },
];

export function EndpointsCard({ endpoints, className }: EndpointsCardProps) {
  return (
    <Card flush className={cn('flex flex-col', className)}>
      <div className="px-4 pt-4 pb-3">
        <CardHeader title="Endpoints" description="Requests, errors and mean latency over the last hour." />
      </div>
      <div className="px-1 pb-2">
        <DataTable
          rows={endpoints}
          columns={COLUMNS}
          getRowId={(row) => row.surface}
          caption="API surfaces, their state, and last-hour counters"
          emptyState={
            <StateView
              kind="empty"
              title="No endpoints"
              description="No API surface has reported traffic yet."
            />
          }
        />
      </div>
    </Card>
  );
}
