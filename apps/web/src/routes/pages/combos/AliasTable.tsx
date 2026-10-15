import { RefreshCw } from 'lucide-react';

import type { Alias, Provider, SortDirection } from '@contracts';

import { DataTable, type SortState } from '@web/components/patterns/DataTable.tsx';
import { ListToolbar } from '@web/components/patterns/ListToolbar.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useAliases } from '@web/hooks/use-routing.ts';
import { formatCount } from '@web/lib/format.ts';
import {
  ENABLED_OPTIONS,
  isEnabledFilter,
  listNarrowed,
  matchesEnabled,
  type EnabledFilter,
  type ListCount,
} from '@web/lib/list-filters.ts';

import { aliasColumns } from './route-columns.tsx';
import { ROUTE_PAGE_SIZE } from './combos.ts';

/**
 * The aliases half of the page.
 *
 * Same shape as the combo table, and deliberately so: the two tabs differ in
 * what a row means, not in how a list behaves. Both own their query so only the
 * visible tab fetches, both narrow the enabled filter in the browser, and both
 * read the same four states.
 */

/** How many placeholder rows to draw while the first page is in flight. */
const SKELETON_ROWS = 6;

/** Six columns, in the order `aliasColumns` declares them. */
const SKELETON_COLUMN_WIDTHS = ['w-24', 'w-32', 'w-40', 'w-16', 'w-10', 'w-12'];

function TableSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading aliases" className="@container">
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

export interface AliasTableProps {
  readonly search: string;
  readonly enabled: EnabledFilter;
  readonly sort: string;
  readonly direction: SortDirection;
  readonly onSearchChange: (value: string) => void;
  readonly onEnabledChange: (value: EnabledFilter) => void;
  readonly onClearFilters: () => void;
  readonly onSortChange: (next: SortState) => void;
  readonly providerById: ReadonlyMap<string, Provider>;
  readonly onEdit: (alias: Alias) => void;
  readonly onDelete: (alias: Alias) => void;
  readonly onToggleEnabled: (alias: Alias, enabled: boolean) => void;
  readonly onNew: () => void;
}

export function AliasTable({
  search,
  enabled,
  sort,
  direction,
  onSearchChange,
  onEnabledChange,
  onClearFilters,
  onSortChange,
  providerById,
  onEdit,
  onDelete,
  onToggleEnabled,
  onNew,
}: AliasTableProps) {
  const aliases = useAliases({ q: search, sort, direction, limit: ROUTE_PAGE_SIZE });
  const all = (aliases.data?.pages ?? []).flatMap((page) => page.items);
  const total = aliases.data?.pages[0]?.total ?? null;
  const rows = all.filter((alias) => matchesEnabled(alias.enabled, enabled));

  const columns = aliasColumns({ providerById, onEdit, onDelete, onToggleEnabled });
  const narrowed = listNarrowed(search, enabled);

  const count: ListCount = aliases.isPending
    ? { kind: 'loading' }
    : aliases.isError
      ? { kind: 'error' }
      : { kind: 'ready', shown: rows.length, total: total ?? rows.length };

  const toolbar = (
    <ListToolbar
      search={search}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search alias, target or description…"
      filters={[
        {
          value: enabled,
          options: ENABLED_OPTIONS,
          onChange: (next) => {
            if (isEnabledFilter(next)) onEnabledChange(next);
          },
          label: 'Filter by state',
        },
      ]}
      count={count}
      noun={{ one: 'alias', many: 'aliases' }}
      narrowed={listNarrowed(search, enabled)}
      onClear={onClearFilters}
    />
  );

  if (aliases.isPending) {
    return (
      <div className="flex flex-col gap-4">
        {toolbar}
        <TableSkeleton />
      </div>
    );
  }

  if (aliases.isError) {
    return (
      <div className="flex flex-col gap-4">
        {toolbar}
        <Card>
          <StateView
            kind="error"
            title="Could not load the aliases"
            description="The console API did not answer. Check that the server is running, then try again."
            action={
              <Button
                variant="secondary"
                size="sm"
                loading={aliases.isFetching}
                onClick={() => {
                  void aliases.refetch();
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
        caption="Model aliases"
        sort={{ key: sort, direction }}
        onSortChange={onSortChange}
        emptyState={
          <StateView
            kind={narrowed ? 'no-results' : 'empty'}
            title={narrowed ? 'No aliases match' : 'No aliases yet'}
            description={
              narrowed
                ? 'Nothing here matches these filters. Widen them, or clear the search.'
                : 'An alias gives a client the name it already sends, and points it at the model you want it to reach.'
            }
            action={
              narrowed ? (
                <Button variant="secondary" size="sm" onClick={onClearFilters}>
                  Clear filters
                </Button>
              ) : (
                <Button size="sm" onClick={onNew}>
                  New alias
                </Button>
              )
            }
          />
        }
        footer={
          aliases.hasNextPage ? (
            <div className="flex justify-center py-1">
              <Button
                variant="secondary"
                size="sm"
                loading={aliases.isFetchingNextPage}
                onClick={() => {
                  void aliases.fetchNextPage();
                }}
              >
                Load more
                <span className="tabular-nums text-text-muted">
                  ({formatCount(all.length)} of {formatCount(total ?? all.length)})
                </span>
              </Button>
            </div>
          ) : (
            <p className="py-1 text-center text-xs tabular-nums text-text-subtle">
              {formatCount(rows.length)} of {formatCount(total ?? rows.length)} aliases
            </p>
          )
        }
      />
    </div>
  );
}
