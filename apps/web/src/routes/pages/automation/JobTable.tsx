import { RefreshCw } from 'lucide-react';
import { Link } from 'react-router';

import type { Job, Provider, SortDirection } from '@contracts';

import { DataTable, type SortState } from '@web/components/patterns/DataTable.tsx';
import { ListToolbar } from '@web/components/patterns/ListToolbar.tsx';
import { JOB_STATUS_OPTIONS } from '@web/components/patterns/job-vocabulary.ts';
import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { buttonVariants } from '@web/components/ui/button-variants.ts';
import { useJobs } from '@web/hooks/use-automation.ts';
import { formatCount } from '@web/lib/format.ts';
import type { ListCount } from '@web/lib/list-filters.ts';

import { BULK_PATH } from './automation.ts';
import { jobColumns } from './job-columns.tsx';
import {
  ANY_PROVIDER,
  JOB_PAGE_SIZE,
  isStatusFilter,
  jobNarrowed,
  statusParam,
  type JobSortKey,
  type StatusFilter,
} from './logs.ts';

/**
 * The job history: its filter bar, its table, and the query behind both.
 *
 * Both filters run on the server, because both are things the endpoint already
 * narrows on and because a history is the one list here that is expected to grow
 * without bound — a client-side filter over a paged list would only ever narrow
 * the page you happen to be looking at.
 *
 * A row opens the drawer rather than linking away, so an operator can step down
 * a column of failures without losing their place in the list.
 */

/** How many placeholder rows to draw while the first page is in flight. */
const SKELETON_ROWS = 6;

/** Six columns, in the order `jobColumns` declares them. */
const SKELETON_COLUMN_WIDTHS = ['w-40', 'w-24', 'w-20', 'w-28', 'w-20', 'w-16'];

function TableSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading job history" className="@container">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border">
              {SKELETON_COLUMN_WIDTHS.map((width, index) => (
                <th key={index} scope="col" className="px-3 py-2 text-left">
                  <Skeleton shape="text" className={width} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: SKELETON_ROWS }, (_, rowIndex) => (
              <tr key={rowIndex} className="border-b border-border/60 last:border-0">
                {SKELETON_COLUMN_WIDTHS.map((width, cellIndex) => (
                  <td key={cellIndex} className="px-3 py-2.5">
                    <Skeleton shape="text" className={width} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export interface JobTableProps {
  readonly search: string;
  readonly provider: string;
  readonly status: StatusFilter;
  readonly sort: JobSortKey;
  readonly direction: SortDirection;
  readonly providers: readonly Provider[];
  /** The job whose drawer is open, so its row reads as selected. */
  readonly activeJobId: string | null;
  readonly onSearchChange: (value: string) => void;
  readonly onProviderChange: (value: string) => void;
  readonly onStatusChange: (value: StatusFilter) => void;
  readonly onClearFilters: () => void;
  readonly onSortChange: (next: SortState) => void;
  readonly onOpen: (job: Job) => void;
}

export function JobTable({
  search,
  provider,
  status,
  sort,
  direction,
  providers,
  activeJobId,
  onSearchChange,
  onProviderChange,
  onStatusChange,
  onClearFilters,
  onSortChange,
  onOpen,
}: JobTableProps) {
  const jobs = useJobs({
    providerId: provider === ANY_PROVIDER ? null : provider,
    status: statusParam(status),
    q: search,
    sort,
    direction,
    limit: JOB_PAGE_SIZE,
  });

  const rows = (jobs.data?.pages ?? []).flatMap((page) => page.items);
  const total = jobs.data?.pages[0]?.total ?? null;
  const columns = jobColumns({ providers });
  const narrowed = jobNarrowed(search, provider, status);

  const count: ListCount = jobs.isPending
    ? { kind: 'loading' }
    : jobs.isError
      ? { kind: 'error' }
      : { kind: 'ready', shown: rows.length, total: total ?? rows.length };

  /**
   * "Any provider" is a real option rather than a placeholder, because a select
   * that can only narrow is a select you cannot undo — and it keeps the control
   * usable while the catalog is still loading, which is when its other options
   * are not there yet.
   */
  const providerOptions = [
    { value: ANY_PROVIDER, label: 'Any provider' },
    ...providers.map((entry) => ({ value: entry.id, label: entry.name })),
  ];

  const toolbar = (
    <ListToolbar
      search={search}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search job id, provider or engine…"
      filters={[
        {
          value: provider,
          options: providerOptions,
          onChange: onProviderChange,
          label: 'Filter by provider',
          widthClassName: '@[480px]:w-48',
        },
        {
          value: status,
          options: JOB_STATUS_OPTIONS,
          onChange: (next) => {
            if (isStatusFilter(next)) onStatusChange(next);
          },
          label: 'Filter by status',
          widthClassName: '@[480px]:w-40',
        },
      ]}
      count={count}
      noun={{ one: 'job', many: 'jobs' }}
      narrowed={narrowed}
      onClear={onClearFilters}
    />
  );

  if (jobs.isPending) {
    return (
      <div className="flex flex-col gap-4">
        {toolbar}
        <TableSkeleton />
      </div>
    );
  }

  if (jobs.isError) {
    return (
      <div className="flex flex-col gap-4">
        {toolbar}
        <Card>
          <StateView
            kind="error"
            title="Could not load the job history"
            description="The console API did not answer. Check that the server is running, then try again."
            action={
              <Button
                variant="secondary"
                size="sm"
                loading={jobs.isFetching}
                onClick={() => {
                  void jobs.refetch();
                }}
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
                Retry
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {toolbar}
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        caption="Import jobs"
        sort={{ key: sort, direction }}
        onSortChange={onSortChange}
        activeRowId={activeJobId}
        onRowClick={onOpen}
        emptyState={
          <StateView
            kind={narrowed ? 'no-results' : 'empty'}
            title={narrowed ? 'No jobs match' : 'No imports yet'}
            description={
              narrowed
                ? 'Nothing in the history matches these filters. Widen them, or clear the search.'
                : 'Every batch import lands here when it finishes, with the steps each credential went through and the captures taken along the way.'
            }
            action={
              narrowed ? (
                <Button variant="secondary" size="sm" onClick={onClearFilters}>
                  Clear filters
                </Button>
              ) : (
                <Link to={BULK_PATH} className={buttonVariants({ size: 'sm' })}>
                  Start an import
                </Link>
              )
            }
          />
        }
        footer={
          jobs.hasNextPage ? (
            <div className="flex justify-center py-1">
              <Button
                variant="secondary"
                size="sm"
                loading={jobs.isFetchingNextPage}
                onClick={() => {
                  void jobs.fetchNextPage();
                }}
              >
                Load more
                <span className="tabular-nums text-text-muted">
                  ({formatCount(rows.length)} of {formatCount(total ?? rows.length)})
                </span>
              </Button>
            </div>
          ) : (
            <p className="py-1 text-center text-xs tabular-nums text-text-subtle">
              {formatCount(rows.length)} of {formatCount(total ?? rows.length)} jobs
            </p>
          )
        }
      />
    </div>
  );
}
