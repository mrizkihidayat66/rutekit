import { RefreshCw } from 'lucide-react';

import type { ApiKey, SortDirection } from '@contracts';

import { DataTable, type SortState } from '@web/components/patterns/DataTable.tsx';
import { ListToolbar } from '@web/components/patterns/ListToolbar.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useApiKeys } from '@web/hooks/use-routing.ts';
import { formatCount } from '@web/lib/format.ts';
import type { ListCount } from '@web/lib/list-filters.ts';

import { keyColumns } from './key-columns.tsx';
import {
  KEY_FILTER_OPTIONS,
  KEY_PAGE_SIZE,
  isKeyFilter,
  keyNarrowed,
  stateParam,
  type KeyFilter,
} from './keys.ts';

/**
 * The API-key list: its filter bar, its table, and the query behind both.
 *
 * Unlike the other routing lists, the state filter runs on the server. A key's
 * state is derived from its revocation, its expiry and its spend, so narrowing
 * it in the browser would mean paging through every key and keeping only the
 * ones that happened to land on this page — which is not a filter, it is a
 * coincidence. The endpoint already takes `?state=`, so the page uses it.
 *
 * The consequence is that `shown` and `total` both come from the server, and the
 * search is the server's too: this list is the one on the page where an operator
 * plausibly has hundreds of keys, so nothing here is narrowed client-side.
 */

/** How many placeholder rows to draw while the first page is in flight. */
const SKELETON_ROWS = 6;

/** Eight columns, in the order `keyColumns` declares them. */
const SKELETON_COLUMN_WIDTHS = ['w-32', 'w-20', 'w-16', 'w-24', 'w-20', 'w-24', 'w-16', 'w-12'];

function TableSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading API keys" className="@container">
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

export interface KeyTableProps {
  readonly search: string;
  readonly filter: KeyFilter;
  readonly sort: string;
  readonly direction: SortDirection;
  readonly onSearchChange: (value: string) => void;
  readonly onFilterChange: (value: KeyFilter) => void;
  readonly onClearFilters: () => void;
  readonly onSortChange: (next: SortState) => void;
  readonly onEdit: (key: ApiKey) => void;
  readonly onRevoke: (key: ApiKey) => void;
  readonly onDelete: (key: ApiKey) => void;
  readonly onNew: () => void;
}

export function KeyTable({
  search,
  filter,
  sort,
  direction,
  onSearchChange,
  onFilterChange,
  onClearFilters,
  onSortChange,
  onEdit,
  onRevoke,
  onDelete,
  onNew,
}: KeyTableProps) {
  const keys = useApiKeys({
    state: stateParam(filter),
    q: search,
    sort,
    direction,
    limit: KEY_PAGE_SIZE,
  });

  const rows = (keys.data?.pages ?? []).flatMap((page) => page.items);
  const total = keys.data?.pages[0]?.total ?? null;
  const columns = keyColumns({ onEdit, onRevoke, onDelete });
  const narrowed = keyNarrowed(search, filter);

  const count: ListCount = keys.isPending
    ? { kind: 'loading' }
    : keys.isError
      ? { kind: 'error' }
      : { kind: 'ready', shown: rows.length, total: total ?? rows.length };

  const toolbar = (
    <ListToolbar
      search={search}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search name or prefix…"
      filters={[
        {
          value: filter,
          options: KEY_FILTER_OPTIONS,
          onChange: (next) => {
            if (isKeyFilter(next)) onFilterChange(next);
          },
          label: 'Filter by state',
          widthClassName: '@[480px]:w-40',
        },
      ]}
      count={count}
      noun={{ one: 'key', many: 'keys' }}
      narrowed={narrowed}
      onClear={onClearFilters}
    />
  );

  if (keys.isPending) {
    return (
      <div className="flex flex-col gap-4">
        {toolbar}
        <TableSkeleton />
      </div>
    );
  }

  if (keys.isError) {
    return (
      <div className="flex flex-col gap-4">
        {toolbar}
        <Card>
          <StateView
            kind="error"
            title="Could not load the API keys"
            description="The console API did not answer. Check that the server is running, then try again."
            action={
              <Button
                variant="secondary"
                size="sm"
                loading={keys.isFetching}
                onClick={() => {
                  void keys.refetch();
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
        caption="API keys"
        sort={{ key: sort, direction }}
        onSortChange={onSortChange}
        emptyState={
          <StateView
            kind={narrowed ? 'no-results' : 'empty'}
            title={narrowed ? 'No keys match' : 'No API keys yet'}
            description={
              narrowed
                ? 'Nothing here matches these filters. Widen them, or clear the search.'
                : 'A key is what a client authenticates with. Each one carries its own model scope, expiry, rate limits and budget, so a single client can be capped without affecting the rest.'
            }
            action={
              narrowed ? (
                <Button variant="secondary" size="sm" onClick={onClearFilters}>
                  Clear filters
                </Button>
              ) : (
                <Button size="sm" onClick={onNew}>
                  Create a key
                </Button>
              )
            }
          />
        }
        footer={
          keys.hasNextPage ? (
            <div className="flex justify-center py-1">
              <Button
                variant="secondary"
                size="sm"
                loading={keys.isFetchingNextPage}
                onClick={() => {
                  void keys.fetchNextPage();
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
              {formatCount(rows.length)} of {formatCount(total ?? rows.length)} keys
            </p>
          )
        }
      />
    </div>
  );
}
