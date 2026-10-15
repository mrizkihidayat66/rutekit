import { Plus, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { Account, AccountsQuery, SortDirection } from '@contracts';

import { DataTable } from '@web/components/patterns/DataTable.tsx';
import { ImportCredentialDialog } from '@web/components/patterns/ImportCredentialDialog.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useClock } from '@web/hooks/useClock.ts';
import { useAccounts, useProviders } from '@web/hooks/use-providers.ts';
import { useUrlParam, useUrlText } from '@web/hooks/use-url-state.ts';
import { formatCount } from '@web/lib/format.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { AccountEditDrawer } from './accounts/AccountEditDrawer.tsx';
import { AccountsToolbar } from './accounts/AccountsToolbar.tsx';
import { BulkActionBar } from './accounts/BulkActionBar.tsx';
import { accountColumns } from './accounts/account-columns.tsx';
import {
  ACCOUNT_DIRECTIONS,
  ACCOUNT_PAGE_SIZE,
  ACCOUNT_SORT_KEYS,
  DEFAULT_ACCOUNT_DIRECTION,
  DEFAULT_ACCOUNT_SORT,
  STATE_VALUES,
  filtersActive,
  isAccountDirection,
  isAccountSortKey,
  type AccountCount,
  type AccountSortKey,
  type StateFilter,
} from './accounts/accounts.ts';
import { useRowSelection } from '@web/hooks/use-row-selection.ts';

/**
 * Accounts: the whole credential pool, in one table.
 *
 * Provider Detail shows the same pool narrowed to one provider; this is the view
 * that crosses providers, which is what makes it the place for the questions that
 * only make sense in aggregate — which keys are banned, what is cooling down
 * right now, what has never been used. Those are exactly the filters, and they
 * live in the URL so `/accounts?state=banned` is a link worth pasting.
 *
 * The table is the page. Everything around it is either a filter, a way to act
 * on a selection, or one of the four states; there is no summary above it,
 * because the toolbar's count already answers "how many".
 */

/** How many placeholder rows to draw while the first page is in flight. */
const SKELETON_ROWS = 10;

/** Nine columns, in the order the table declares them. */
const SKELETON_COLUMN_WIDTHS = [
  'w-4',
  'w-32',
  'w-24',
  'w-16',
  'w-10',
  'w-14',
  'w-24',
  'w-16',
  'w-4',
];

function TableSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading accounts" className="@container">
      {/* Scrolls like the real table below it, so the frame does not jump when rows arrive. */}
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

export function AccountsPage() {
  const [search, setSearch] = useUrlText('q');
  const [providerId, setProviderId] = useUrlParam<string>('providerId', '');
  const [state, setState] = useUrlParam<StateFilter>('state', 'all', STATE_VALUES);
  const [sortKey, setSortKey] = useUrlParam<AccountSortKey>(
    'sort',
    DEFAULT_ACCOUNT_SORT,
    ACCOUNT_SORT_KEYS,
  );
  const [direction, setDirection] = useUrlParam<SortDirection>(
    'direction',
    DEFAULT_ACCOUNT_DIRECTION,
    ACCOUNT_DIRECTIONS,
  );

  const [importOpen, setImportOpen] = useState(false);
  const [importOpener, setImportOpener] = useState<HTMLElement | null>(null);
  const [editing, setEditing] = useState<Account | null>(null);

  const now = useClock();
  const nowMs = now.getTime();

  const query: Omit<AccountsQuery, 'cursor'> = {
    q: search,
    providerId: providerId === '' ? null : providerId,
    state: state === 'all' ? null : state,
    sort: sortKey,
    direction,
    limit: ACCOUNT_PAGE_SIZE,
  };

  const accounts = useAccounts(query);
  const rows = (accounts.data?.pages ?? []).flatMap((page) => page.items);
  const total = accounts.data?.pages[0]?.total ?? null;

  // The whole catalog, for the provider filter and the import dialog's picker.
  // It is a small fixed list, so it is fetched once, sorted by name, rather than
  // paged like the catalog page does.
  const catalog = useProviders({
    q: '',
    category: null,
    status: null,
    tier: 'all',
    sort: 'name',
    direction: 'asc',
    limit: 200,
  });
  const providers = (catalog.data?.pages ?? []).flatMap((page) => page.items);
  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  );

  const ids = useMemo(() => rows.map((row) => row.id), [rows]);
  const selection = useRowSelection(ids, `${search}|${providerId}|${state}`);

  const narrowed = filtersActive({ search, providerId, state });

  const count: AccountCount = accounts.isPending
    ? { kind: 'loading' }
    : accounts.isError
      ? { kind: 'error' }
      : { kind: 'ready', total: total ?? rows.length };

  const clear = () => {
    setSearch('');
    setProviderId('');
    setState('all');
  };

  const openImport = () => {
    setImportOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setImportOpen(true);
  };

  const columns = accountColumns({
    nowMs,
    selected: selection.selected,
    onToggle: selection.toggle,
    allSelected: selection.allSelected,
    someSelected: selection.someSelected,
    onToggleAll: selection.toggleAll,
    shiftHeld: selection.shiftHeld,
    providerById,
    onEdit: setEditing,
  });

  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="Accounts"
        description="Every credential in the pool. Filter to the ones that need attention, then act on them in bulk."
        actions={
          <Button onClick={openImport}>
            <Plus aria-hidden="true" className="size-4" />
            Import credential
          </Button>
        }
      />

      <div className="@container flex flex-col gap-4">
        <AccountsToolbar
          filters={{ search, providerId, state }}
          count={count}
          providerOptions={[
            { value: '', label: 'All providers' },
            ...providers.map((provider) => ({ value: provider.id, label: provider.name })),
          ]}
          onSearchChange={setSearch}
          onProviderChange={setProviderId}
          onStateChange={setState}
          onClear={clear}
        />

        <BulkActionBar ids={[...selection.selected]} onClear={selection.clear} />

        {accounts.isPending ? (
          <TableSkeleton />
        ) : accounts.isError ? (
          <Card>
            <StateView
              kind="error"
              title="Could not load the pool"
              description="The console API did not answer. Check that the server is running, then try again."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  loading={accounts.isFetching}
                  onClick={() => {
                    void accounts.refetch();
                  }}
                >
                  <RefreshCw aria-hidden="true" className="size-3.5" />
                  Retry
                </Button>
              }
            />
          </Card>
        ) : (
          <DataTable
            rows={rows}
            columns={columns}
            getRowId={(row) => row.id}
            caption="Credential pool"
            sort={{ key: sortKey, direction }}
            onSortChange={(next) => {
              if (next.key !== null && isAccountSortKey(next.key)) setSortKey(next.key);
              if (isAccountDirection(next.direction)) setDirection(next.direction);
            }}
            emptyState={
              <StateView
                kind={narrowed ? 'no-results' : 'empty'}
                title={narrowed ? 'No accounts match' : 'The pool is empty'}
                description={
                  narrowed
                    ? 'Nothing in the pool matches these filters. Widen them, or clear the search.'
                    : 'Import a credential, or sign a provider in through its own OAuth flow, and the router will start routing to it.'
                }
                action={
                  narrowed ? (
                    <Button variant="secondary" size="sm" onClick={clear}>
                      Clear filters
                    </Button>
                  ) : (
                    <Button size="sm" onClick={openImport}>
                      <Plus aria-hidden="true" className="size-3.5" />
                      Import credential
                    </Button>
                  )
                }
              />
            }
            footer={
              accounts.hasNextPage ? (
                <div className="flex justify-center py-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={accounts.isFetchingNextPage}
                    onClick={() => {
                      void accounts.fetchNextPage();
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
                  {formatCount(rows.length)} of {formatCount(total ?? rows.length)} accounts
                </p>
              )
            }
          />
        )}
      </div>

      <ImportCredentialDialog
        provider={null}
        providers={providers}
        open={importOpen}
        onOpenChange={setImportOpen}
        restoreFocusTo={importOpener}
      />

      <AccountEditDrawer
        account={editing}
        providers={providers}
        onClose={() => {
          setEditing(null);
        }}
      />
    </div>
  );
}
