import type { Job, Provider } from '@contracts';

import type { DataTableColumn } from '@web/components/patterns/DataTable.tsx';
import { Meter } from '@web/components/patterns/Meter.tsx';
import { ProviderIcon } from '@web/components/patterns/ProviderIcon.tsx';
import { JobStatusBadge } from '@web/components/patterns/JobStatusBadge.tsx';
import {
  ENGINE_LABELS,
  JOB_METHOD_LABELS,
  JOB_STATUS_TONES,
  jobProgress,
} from '@web/components/patterns/job-vocabulary.ts';
import { cn } from '@web/lib/cn.ts';
import { formatCount, formatDurationMs, formatRelative } from '@web/lib/format.ts';

import { jobDuration } from './logs.ts';

/**
 * The job history's columns.
 *
 * A history row is read to answer one of two questions, and the order of the
 * columns is what lets both be answered without opening anything. Scanning asks
 * "did anything go wrong" — status, then progress, which between them say
 * whether a batch finished, stalled or died. Opening one asks "which batch is
 * this" — the provider it targeted and when it ran.
 *
 * The progress bar is tinted by the job's status rather than by how full it is.
 * A bar that fills towards red as it advances would read as a problem on a job
 * that is simply large; here the colour means the same thing the badge beside it
 * means, so the two can never disagree.
 */

export interface JobColumnsOptions {
  /** The catalog, for naming and drawing the provider a job targeted. */
  readonly providers: readonly Provider[];
}

export function jobColumns({ providers }: JobColumnsOptions): readonly DataTableColumn<Job>[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));

  return [
    {
      id: 'job',
      header: 'Job',
      sortKey: 'createdAt',
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-mono text-xs font-medium text-text" title={row.id}>
            {row.id}
          </span>
          <span className="truncate text-[0.6875rem] text-text-subtle">
            {formatRelative(row.createdAt)}
          </span>
        </span>
      ),
    },
    {
      id: 'provider',
      header: 'Provider',
      sortKey: 'providerId',
      hideBelow: 'sm',
      cell: (row) => {
        const provider = byId.get(row.providerId);
        return (
          <span className="inline-flex min-w-0 items-center gap-2">
            <ProviderIcon icon={provider?.icon ?? 'box'} size="sm" />
            <span className="truncate text-xs text-text" title={provider?.name ?? row.providerId}>
              {provider?.name ?? row.providerId}
            </span>
          </span>
        );
      },
    },
    {
      id: 'status',
      header: 'Status',
      widthClassName: 'w-32',
      cell: (row) => <JobStatusBadge status={row.status} size="sm" />,
    },
    {
      id: 'progress',
      header: 'Progress',
      sortKey: 'total',
      cellClassName: 'min-w-[10rem]',
      cell: (row) => {
        const progress = jobProgress(row);
        return (
          <span className="flex flex-col gap-1">
            <Meter
              value={progress.ratio}
              max={1}
              label={`Progress of ${row.id}`}
              tone={JOB_STATUS_TONES[row.status]}
              size="sm"
            />
            <span className="text-[0.6875rem] tabular-nums text-text-muted">
              {formatCount(progress.done)} of {formatCount(row.total)}
              {row.failed === 0 ? null : (
                <span className="text-danger-text"> · {formatCount(row.failed)} failed</span>
              )}
              {row.needsManual === 0 ? null : (
                <span className="text-warning-text"> · {formatCount(row.needsManual)} blocked</span>
              )}
            </span>
          </span>
        );
      },
    },
    {
      id: 'method',
      header: 'Method',
      hideBelow: 'lg',
      cell: (row) => (
        <span className="flex flex-col">
          <span className="text-xs text-text">{JOB_METHOD_LABELS[row.method]}</span>
          <span className="text-[0.6875rem] text-text-subtle">
            {row.engine === null ? 'No browser' : ENGINE_LABELS[row.engine]}
          </span>
        </span>
      ),
    },
    {
      id: 'duration',
      header: 'Duration',
      sortKey: 'finishedAt',
      align: 'end',
      hideBelow: 'md',
      cell: (row) => {
        const duration = jobDuration(row);
        return (
          <span className={cn('tabular-nums', duration === null ? 'text-text-subtle' : 'text-text-muted')}>
            {duration === null ? '—' : formatDurationMs(duration)}
          </span>
        );
      },
    },
  ];
}
