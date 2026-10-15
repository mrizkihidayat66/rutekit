import { RefreshCw } from 'lucide-react';
import { useState } from 'react';

import type { Proxy, ProxyHealth, SortDirection } from '@contracts';

import { DataTable, type SortState } from '@web/components/patterns/DataTable.tsx';
import { ListToolbar } from '@web/components/patterns/ListToolbar.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useCheckProxies, useProxies } from '@web/hooks/use-automation.ts';
import { useRowSelection } from '@web/hooks/use-row-selection.ts';
import { formatCount } from '@web/lib/format.ts';
import type { ListCount } from '@web/lib/list-filters.ts';

import { ProxyActionBar } from './ProxyActionBar.tsx';
import { proxyColumns } from './proxy-columns.tsx';
import {
  PROXY_HEALTHS,
  PROXY_HEALTH_LABELS,
  PROXY_PAGE_SIZE,
  PROXY_PROTOCOLS,
  PROXY_PROTOCOL_LABELS,
  isHealthFilter,
  isProtocolFilter,
  protocolParam,
  proxyNarrowed,
  healthParam,
  type HealthFilter,
  type ProtocolFilter,
  type ProxySortKey,
} from './proxies.ts';

/**
 * The pool: its status line, its filter bar, its table, and the queries behind all
 * three.
 *
 * Both filters run on the server, because both are things the endpoint already
 * narrows on and because a pool is expected to grow — a client-side filter over a
 * paged list would only ever narrow the page you happen to be looking at.
 *
 * The status line above the toolbar is where the check lives rather than the page
 * header, because checking is a thing done *to this list*: the count it reports
 * and the rows it recolours are both right underneath it. After a sweep it says
 * what the sweep found, which is the one piece of feedback the tiles cannot give
 * — they say what the pool is, not what just happened to it.
 */

/** How many placeholder rows to draw while the first page is in flight. */
const SKELETON_ROWS = 8;

/** Six columns, in the order `proxyColumns` declares them. */
const SKELETON_COLUMN_WIDTHS = ['w-4', 'w-44', 'w-24', 'w-16', 'w-16', 'w-20'];

function TableSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading proxies" className="@container">
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
function sweepSummary(results: readonly { readonly health: ProxyHealth }[]): string {
  const counts = new Map<ProxyHealth, number>();
  for (const result of results) {
    counts.set(result.health, (counts.get(result.health) ?? 0) + 1);
  }
  return PROXY_HEALTHS.filter((health) => (counts.get(health) ?? 0) > 0)
    .map((health) => `${formatCount(counts.get(health) ?? 0)} ${PROXY_HEALTH_LABELS[health].toLowerCase()}`)
    .join(' · ');
}

export interface ProxyTableProps {
  readonly search: string;
  readonly protocol: ProtocolFilter;
  readonly health: HealthFilter;
  readonly sort: ProxySortKey;
  readonly direction: SortDirection;
  readonly onSearchChange: (value: string) => void;
  readonly onProtocolChange: (value: ProtocolFilter) => void;
  readonly onHealthChange: (value: HealthFilter) => void;
  readonly onClearFilters: () => void;
  readonly onSortChange: (next: SortState) => void;
  /**
   * Bumped by the page whenever the pool's contents change under the selection,
   * so rows that no longer exist stop being counted as ticked.
   */
  readonly resetToken: number;
  readonly onAdd: () => void;
  readonly onEdit: (proxy: Proxy) => void;
  readonly onDelete: (proxy: Proxy) => void;
  readonly onDeleteSelected: (ids: readonly string[]) => void;
}

export function ProxyTable({
  search,
  protocol,
  health,
  sort,
  direction,
  onSearchChange,
  onProtocolChange,
  onHealthChange,
  onClearFilters,
  onSortChange,
  resetToken,
  onAdd,
  onEdit,
  onDelete,
  onDeleteSelected,
}: ProxyTableProps) {
  const proxies = useProxies({
    protocol: protocolParam(protocol),
    health: healthParam(health),
    q: search,
    sort,
    direction,
    limit: PROXY_PAGE_SIZE,
  });

  const check = useCheckProxies();
  const [checkedCount, setCheckedCount] = useState<number | null>(null);

  const rows = (proxies.data?.pages ?? []).flatMap((page) => page.items);
  const total = proxies.data?.pages[0]?.total ?? null;
  const ids = rows.map((row) => row.id);

  const selection = useRowSelection(
    ids,
    `${search}|${protocol}|${health}|${sort}|${direction}|${String(resetToken)}`,
  );
  const narrowed = proxyNarrowed(search, protocol, health);

  const checking = check.isPending;
  // A sweep of one row is that row's own button spinning; a sweep of the pool or
  // of a selection has no single row to point at, so nothing spins.
  const checkedIds = check.variables?.ids ?? [];
  const checkingId = checking && checkedIds.length === 1 ? (checkedIds[0] ?? null) : null;

  const count: ListCount = proxies.isPending
    ? { kind: 'loading' }
    : proxies.isError
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

  const columns = proxyColumns({
    selected: selection.selected,
    onToggle: selection.toggle,
    allSelected: selection.allSelected,
    someSelected: selection.someSelected,
    onToggleAll: selection.toggleAll,
    shiftHeld: selection.shiftHeld,
    checkingId,
    onCheck: (proxy) => {
      runCheck([proxy.id]);
    },
    onEdit,
    onDelete,
  });

  /**
   * "Any protocol" and "Any health" are real options rather than placeholders,
   * because a select that can only narrow is a select you cannot undo.
   */
  const toolbar = (
    <ListToolbar
      search={search}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search host, id or note…"
      filters={[
        {
          value: protocol,
          options: [
            { value: 'all', label: 'Any protocol' },
            ...PROXY_PROTOCOLS.map((value) => ({ value, label: PROXY_PROTOCOL_LABELS[value] })),
          ],
          onChange: (next) => {
            if (isProtocolFilter(next)) onProtocolChange(next);
          },
          label: 'Filter by protocol',
          widthClassName: '@[480px]:w-40',
        },
        {
          value: health,
          options: [
            { value: 'all', label: 'Any health' },
            ...PROXY_HEALTHS.map((value) => ({ value, label: PROXY_HEALTH_LABELS[value] })),
          ],
          onChange: (next) => {
            if (isHealthFilter(next)) onHealthChange(next);
          },
          label: 'Filter by health',
          widthClassName: '@[480px]:w-40',
        },
      ]}
      count={count}
      noun={{ one: 'proxy', many: 'proxies' }}
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
            ? 'Sweeping the pool…'
            : checkedCount === null || check.data === undefined
              ? 'Checking a proxy writes its health back to the pool.'
              : `Last sweep reached ${formatCount(checkedCount)} ${
                  checkedCount === 1 ? 'proxy' : 'proxies'
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

  if (proxies.isPending) {
    return (
      <div className="flex flex-col gap-4">
        {sweep}
        {toolbar}
        <TableSkeleton />
      </div>
    );
  }

  if (proxies.isError) {
    return (
      <div className="flex flex-col gap-4">
        {sweep}
        {toolbar}
        <Card>
          <StateView
            kind="error"
            title="Could not load the proxy pool"
            description="The console API did not answer. Check that the server is running, then try again."
            action={
              <Button
                variant="secondary"
                size="sm"
                loading={proxies.isFetching}
                onClick={() => {
                  void proxies.refetch();
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
      <ProxyActionBar
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
        caption="Proxies in the pool"
        sort={{ key: sort, direction }}
        onSortChange={onSortChange}
        emptyState={
          <StateView
            kind={narrowed ? 'no-results' : 'empty'}
            title={narrowed ? 'No proxies match' : 'The pool is empty'}
            description={
              narrowed
                ? 'Nothing in the pool matches these filters. Widen them, or clear the search.'
                : 'Add a proxy one at a time, or paste a list from your seller. The router will only dispatch through proxies it has checked.'
            }
            action={
              narrowed ? (
                <Button variant="secondary" size="sm" onClick={onClearFilters}>
                  Clear filters
                </Button>
              ) : (
                <Button size="sm" onClick={onAdd}>
                  Add a proxy
                </Button>
              )
            }
          />
        }
        footer={
          proxies.hasNextPage ? (
            <div className="flex justify-center py-1">
              <Button
                variant="secondary"
                size="sm"
                loading={proxies.isFetchingNextPage}
                onClick={() => {
                  void proxies.fetchNextPage();
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
              {formatCount(rows.length)} of {formatCount(total ?? rows.length)} proxies
            </p>
          )
        }
      />
    </div>
  );
}
