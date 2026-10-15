import { RefreshCw } from 'lucide-react';
import { useState } from 'react';

import type { SmsProvider, SmsProviderStatus, SortDirection } from '@contracts';

import { DataTable, type SortState } from '@web/components/patterns/DataTable.tsx';
import { ListToolbar } from '@web/components/patterns/ListToolbar.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useCheckSmsProviders, useSmsProviders } from '@web/hooks/use-automation.ts';
import { useRowSelection } from '@web/hooks/use-row-selection.ts';
import { formatCount } from '@web/lib/format.ts';
import type { ListCount } from '@web/lib/list-filters.ts';

import { SmsActionBar } from './SmsActionBar.tsx';
import { smsColumns } from './sms-columns.tsx';
import {
  SMS_PROVIDER_KINDS,
  SMS_PROVIDER_KIND_LABELS,
  SMS_PROVIDER_PAGE_SIZE,
  SMS_PROVIDER_STATUSES,
  SMS_PROVIDER_STATUS_LABELS,
  isKindFilter,
  isStatusFilter,
  kindParam,
  smsProviderNarrowed,
  statusParam,
  type KindFilter,
  type SmsProviderSortKey,
  type StatusFilter,
} from './sms-providers.ts';

/**
 * The pool: its status line, its filter bar, its table, and the queries behind
 * all three.
 *
 * Both filters run on the server, because both are things the endpoint already
 * narrows on and because a pool is expected to grow — a client-side filter over a
 * paged list would only ever narrow the page you happen to be looking at.
 *
 * The status line above the toolbar is where the check lives rather than the page
 * header, because checking is a thing done *to this list*: the count it reports
 * and the rows it recolours are both right underneath it. After a sweep it says
 * what the sweep found, which is the one piece of feedback the tiles cannot give
 * — they say what the pool holds, not what just happened to it.
 */

/** How many placeholder rows to draw while the first page is in flight. */
const SKELETON_ROWS = 8;

/** Seven columns, in the order `smsColumns` declares them. */
const SKELETON_COLUMN_WIDTHS = ['w-4', 'w-44', 'w-24', 'w-20', 'w-20', 'w-32', 'w-20'];

function TableSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading SMS providers" className="@container">
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

/** What a sweep found, tallied the way the tiles tally the pool. */
function sweepSummary(results: readonly { readonly status: SmsProviderStatus }[]): string {
  const counts = new Map<SmsProviderStatus, number>();
  for (const result of results) {
    counts.set(result.status, (counts.get(result.status) ?? 0) + 1);
  }
  return SMS_PROVIDER_STATUSES.filter((status) => (counts.get(status) ?? 0) > 0)
    .map(
      (status) =>
        `${formatCount(counts.get(status) ?? 0)} ${SMS_PROVIDER_STATUS_LABELS[status].toLowerCase()}`,
    )
    .join(' · ');
}

export interface SmsTableProps {
  readonly search: string;
  readonly kind: KindFilter;
  readonly status: StatusFilter;
  readonly sort: SmsProviderSortKey;
  readonly direction: SortDirection;
  readonly onSearchChange: (value: string) => void;
  readonly onKindChange: (value: KindFilter) => void;
  readonly onStatusChange: (value: StatusFilter) => void;
  readonly onClearFilters: () => void;
  readonly onSortChange: (next: SortState) => void;
  /**
   * Bumped by the page whenever the pool's contents change under the selection,
   * so rows that no longer exist stop being counted as ticked.
   */
  readonly resetToken: number;
  readonly onAdd: () => void;
  readonly onEdit: (sms: SmsProvider) => void;
  readonly onDelete: (sms: SmsProvider) => void;
  readonly onDeleteSelected: (ids: readonly string[]) => void;
}

export function SmsTable({
  search,
  kind,
  status,
  sort,
  direction,
  onSearchChange,
  onKindChange,
  onStatusChange,
  onClearFilters,
  onSortChange,
  resetToken,
  onAdd,
  onEdit,
  onDelete,
  onDeleteSelected,
}: SmsTableProps) {
  const providers = useSmsProviders({
    kind: kindParam(kind),
    status: statusParam(status),
    q: search,
    sort,
    direction,
    limit: SMS_PROVIDER_PAGE_SIZE,
  });

  const check = useCheckSmsProviders();
  const [checkedCount, setCheckedCount] = useState<number | null>(null);

  const rows = (providers.data?.pages ?? []).flatMap((page) => page.items);
  const total = providers.data?.pages[0]?.total ?? null;
  const ids = rows.map((row) => row.id);

  const selection = useRowSelection(
    ids,
    `${search}|${kind}|${status}|${sort}|${direction}|${String(resetToken)}`,
  );
  const narrowed = smsProviderNarrowed(search, kind, status);

  const checking = check.isPending;
  // A sweep of one row is that row's own button spinning; a sweep of the pool or
  // of a selection has no single row to point at, so nothing spins.
  const checkedIds = check.variables?.ids ?? [];
  const checkingId = checking && checkedIds.length === 1 ? (checkedIds[0] ?? null) : null;

  const count: ListCount = providers.isPending
    ? { kind: 'loading' }
    : providers.isError
      ? { kind: 'error' }
      : { kind: 'ready', shown: rows.length, total: total ?? rows.length };

  const runCheck = (targets: readonly string[]) => {
    check.mutate(
      { ids: [...targets] },
      {
        onSuccess: (result) => {
          setCheckedCount(result.results.length);
        },
      },
    );
  };

  const columns = smsColumns({
    selected: selection.selected,
    onToggle: selection.toggle,
    allSelected: selection.allSelected,
    someSelected: selection.someSelected,
    onToggleAll: selection.toggleAll,
    shiftHeld: selection.shiftHeld,
    checkingId,
    onCheck: (sms) => {
      runCheck([sms.id]);
    },
    onEdit,
    onDelete,
  });

  /**
   * "Any service" and "Any status" are real options rather than placeholders,
   * because a select that can only narrow is a select you cannot undo.
   */
  const toolbar = (
    <ListToolbar
      search={search}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search label, key or note…"
      filters={[
        {
          value: kind,
          options: [
            { value: 'all', label: 'Any service' },
            ...SMS_PROVIDER_KINDS.map((value) => ({ value, label: SMS_PROVIDER_KIND_LABELS[value] })),
          ],
          onChange: (next) => {
            if (isKindFilter(next)) onKindChange(next);
          },
          label: 'Filter by service',
          widthClassName: '@[480px]:w-40',
        },
        {
          value: status,
          options: [
            { value: 'all', label: 'Any status' },
            ...SMS_PROVIDER_STATUSES.map((value) => ({
              value,
              label: SMS_PROVIDER_STATUS_LABELS[value],
            })),
          ],
          onChange: (next) => {
            if (isStatusFilter(next)) onStatusChange(next);
          },
          label: 'Filter by status',
          widthClassName: '@[480px]:w-40',
        },
      ]}
      count={count}
      noun={{ one: 'key', many: 'keys' }}
      narrowed={narrowed}
      onClear={onClearFilters}
    />
  );

  const sweep = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {check.isError ? (
        <p role="alert" className="text-xs text-danger-text">
          {check.error.message}
        </p>
      ) : (
        <p role="status" aria-live="polite" className="text-xs text-text-muted">
          {checking
            ? 'Reading balances…'
            : checkedCount === null || check.data === undefined
              ? 'Checking a key reads its balance from the service and writes it back here.'
              : `Last check read ${formatCount(checkedCount)} ${
                  checkedCount === 1 ? 'key' : 'keys'
                }: ${sweepSummary(check.data.results)}`}
        </p>
      )}
      <Button
        variant="secondary"
        size="sm"
        loading={checking}
        onClick={() => {
          runCheck([]);
        }}
      >
        <RefreshCw aria-hidden="true" className="size-3.5" />
        Check all
      </Button>
    </div>
  );

  if (providers.isPending) {
    return (
      <div className="flex flex-col gap-4">
        {sweep}
        {toolbar}
        <TableSkeleton />
      </div>
    );
  }

  if (providers.isError) {
    return (
      <div className="flex flex-col gap-4">
        {sweep}
        {toolbar}
        <Card>
          <StateView
            kind="error"
            title="Could not load the SMS pool"
            description="The console API did not answer. Check that the server is running, then try again."
            action={
              <Button
                variant="secondary"
                size="sm"
                loading={providers.isFetching}
                onClick={() => {
                  void providers.refetch();
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
      {sweep}
      {toolbar}
      <SmsActionBar
        count={selection.count}
        checking={checking}
        error={check.isError ? check.error.message : null}
        onCheck={() => {
          runCheck([...selection.selected]);
        }}
        onDelete={() => {
          onDeleteSelected([...selection.selected]);
        }}
        onClear={selection.clear}
      />
      <DataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.id}
        caption="SMS providers in the pool"
        sort={{ key: sort, direction }}
        onSortChange={onSortChange}
        emptyState={
          <StateView
            kind={narrowed ? 'no-results' : 'empty'}
            title={narrowed ? 'No keys match' : 'No key can rent numbers'}
            description={
              narrowed
                ? 'Nothing in the pool matches these filters. Widen them, or clear the search.'
                : 'A registration job rents a phone number for every account it creates, and it pays for that number with a key from this pool. Add one to let it run.'
            }
            action={
              narrowed ? (
                <Button variant="secondary" size="sm" onClick={onClearFilters}>
                  Clear filters
                </Button>
              ) : (
                <Button size="sm" onClick={onAdd}>
                  Add a key
                </Button>
              )
            }
          />
        }
        footer={
          providers.hasNextPage ? (
            <div className="flex justify-center py-1">
              <Button
                variant="secondary"
                size="sm"
                loading={providers.isFetchingNextPage}
                onClick={() => {
                  void providers.fetchNextPage();
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
