import { RefreshCw } from 'lucide-react';

import type { Combo, Provider, SortDirection } from '@contracts';

import { DataTable, type SortState } from '@web/components/patterns/DataTable.tsx';
import { ListToolbar } from '@web/components/patterns/ListToolbar.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useCombos } from '@web/hooks/use-routing.ts';
import { formatCount } from '@web/lib/format.ts';
import {
  ENABLED_OPTIONS,
  isEnabledFilter,
  listNarrowed,
  matchesEnabled,
  type EnabledFilter,
  type ListCount,
} from '@web/lib/list-filters.ts';

import { comboColumns } from './route-columns.tsx';
import { ROUTE_PAGE_SIZE } from './combos.ts';

/**
 * The combos half of the page: its filter bar, its table, and the query behind
 * both.
 *
 * It owns its query rather than taking rows as a prop, which is what lets the
 * aliases tab unmount it and stop the combo list from being fetched. That is the
 * whole reason the two halves are components rather than two branches of one
 * render: a hook cannot be called conditionally, but a component can be.
 *
 * The enabled filter runs here rather than on the server, because the combo list
 * endpoint takes the shared search query and nothing else. Configuration lists
 * run to dozens of rows, so the browser narrows them exactly and for free.
 */

/** How many placeholder rows to draw while the first page is in flight. */
const SKELETON_ROWS = 6;

/** Six columns, in the order `comboColumns` declares them. */
const SKELETON_COLUMN_WIDTHS = ['w-32', 'w-20', 'w-40', 'w-16', 'w-10', 'w-12'];

function TableSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading combos" className="@container">
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

export interface ComboTableProps {
  readonly search: string;
  readonly enabled: EnabledFilter;
  readonly sort: string;
  readonly direction: SortDirection;
  readonly onSearchChange: (value: string) => void;
  readonly onEnabledChange: (value: EnabledFilter) => void;
  readonly onClearFilters: () => void;
  readonly onSortChange: (next: SortState) => void;
  readonly providerById: ReadonlyMap<string, Provider>;
  readonly onEdit: (combo: Combo) => void;
  readonly onDelete: (combo: Combo) => void;
  readonly onToggleEnabled: (combo: Combo, enabled: boolean) => void;
  readonly onNew: () => void;
}

export function ComboTable({
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
}: ComboTableProps) {
  const combos = useCombos({ q: search, sort, direction, limit: ROUTE_PAGE_SIZE });
  const all = (combos.data?.pages ?? []).flatMap((page) => page.items);
  const total = combos.data?.pages[0]?.total ?? null;
  const rows = all.filter((combo) => matchesEnabled(combo.enabled, enabled));

  const columns = comboColumns({ providerById, onEdit, onDelete, onToggleEnabled });
  const narrowed = listNarrowed(search, enabled);

  const count: ListCount = combos.isPending
    ? { kind: 'loading' }
    : combos.isError
      ? { kind: 'error' }
      : { kind: 'ready', shown: rows.length, total: total ?? rows.length };

  const toolbar = (
    <ListToolbar
      search={search}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search name or description…"
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
      noun={{ one: 'combo', many: 'combos' }}
      narrowed={listNarrowed(search, enabled)}
      onClear={onClearFilters}
    />
  );

  if (combos.isPending) {
    return (
      <div className="flex flex-col gap-4">
        {toolbar}
        <TableSkeleton />
      </div>
    );
  }

  if (combos.isError) {
    return (
      <div className="flex flex-col gap-4">
        {toolbar}
        <Card>
          <StateView
            kind="error"
            title="Could not load the combos"
            description="The console API did not answer. Check that the server is running, then try again."
            action={
              <Button
                variant="secondary"
                size="sm"
                loading={combos.isFetching}
                onClick={() => {
                  void combos.refetch();
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
        caption="Combos"
        sort={{ key: sort, direction }}
        onSortChange={onSortChange}
        emptyState={
          <StateView
            kind={narrowed ? 'no-results' : 'empty'}
            title={narrowed ? 'No combos match' : 'No combos yet'}
            description={
              narrowed
                ? 'Nothing here matches these filters. Widen them, or clear the search.'
                : 'A combo is one model name that fans out across several models. Create one to give clients a name that keeps working when a provider does not.'
            }
            action={
              narrowed ? (
                <Button variant="secondary" size="sm" onClick={onClearFilters}>
                  Clear filters
                </Button>
              ) : (
                <Button size="sm" onClick={onNew}>
                  New combo
                </Button>
              )
            }
          />
        }
        footer={
          combos.hasNextPage ? (
            <div className="flex justify-center py-1">
              <Button
                variant="secondary"
                size="sm"
                loading={combos.isFetchingNextPage}
                onClick={() => {
                  void combos.fetchNextPage();
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
              {formatCount(rows.length)} of {formatCount(total ?? rows.length)} combos
            </p>
          )
        }
      />
    </div>
  );
}
