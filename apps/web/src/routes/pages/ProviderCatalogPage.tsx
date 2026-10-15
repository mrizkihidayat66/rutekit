import { Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import type { ProviderCategory, ProviderStatus, ProvidersQuery } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useProviders } from '@web/hooks/use-providers.ts';
import { useUrlParam, useUrlText } from '@web/hooks/use-url-state.ts';
import { formatCount } from '@web/lib/format.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { ByokDialog } from './provider-catalog/ByokDialog.tsx';
import { CatalogToolbar } from './provider-catalog/CatalogToolbar.tsx';
import { ProviderCard } from './provider-catalog/ProviderCard.tsx';
import {
  CATALOG_GRID,
  CATALOG_PAGE_SIZE,
  CATEGORY_VALUES,
  STATUS_VALUES,
  TIERS,
  filtersActive,
  type CatalogCount,
  type Tier,
} from './provider-catalog/catalog.ts';

/**
 * Provider Catalog: every provider rutekit can route to, and the way to add one
 * it has never heard of.
 *
 * The grid is the whole page — an operator comes here to answer "what can this
 * router reach, and what is broken?" — so the only chrome is a filter bar and a
 * single create action. All four filters live in the URL, which is what makes
 * `?tier=free&status=needs_auth` a useful link to hand to someone.
 *
 * Paging is cursor-based and appends. The catalog is small enough that a load-
 * more button beats an infinite scroller: it gives the operator a definite end,
 * and it keeps the page's height stable while they are reading it.
 */

/** How many placeholder cards to draw while the first page is in flight. */
const SKELETON_COUNT = 8;

function GridSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading providers" className={CATALOG_GRID}>
      {Array.from({ length: SKELETON_COUNT }, (_, index) => (
        <Card key={index} className="flex flex-col gap-3 p-4">
          <div className="flex items-center gap-3">
            <Skeleton shape="block" className="size-10 rounded-control" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton shape="text" className="w-24" />
              <Skeleton shape="text" className="w-16" />
            </div>
          </div>
          <Skeleton shape="text" />
          <Skeleton shape="text" className="w-3/4" />
          <Skeleton shape="text" className="mt-2 w-2/3" />
        </Card>
      ))}
    </div>
  );
}

export function ProviderCatalogPage() {
  const [search, setSearch] = useUrlText('q');
  const [category, setCategory] = useUrlParam<'all' | ProviderCategory>(
    'category',
    'all',
    CATEGORY_VALUES,
  );
  const [status, setStatus] = useUrlParam<'all' | ProviderStatus>('status', 'all', STATUS_VALUES);
  const [tier, setTier] = useUrlParam<Tier>('tier', 'all', TIERS);
  const [createOpen, setCreateOpen] = useState(false);
  const [createOpener, setCreateOpener] = useState<HTMLElement | null>(null);

  const query: Omit<ProvidersQuery, 'cursor'> = {
    q: search,
    category: category === 'all' ? null : category,
    status: status === 'all' ? null : status,
    tier,
    sort: null,
    direction: 'desc',
    limit: CATALOG_PAGE_SIZE,
  };

  const providers = useProviders(query);
  const rows = (providers.data?.pages ?? []).flatMap((page) => page.items);
  const total = providers.data?.pages[0]?.total ?? null;
  const narrowed = filtersActive({ search, category, status, tier });

  const count: CatalogCount = providers.isPending
    ? { kind: 'loading' }
    : providers.isError
      ? { kind: 'error' }
      : { kind: 'ready', total: total ?? 0 };

  const clear = () => {
    setSearch('');
    setCategory('all');
    setStatus('all');
    setTier('all');
  };

  // Remember which button opened the wizard so focus can go back to it. There
  // are two of them (the header and the empty state), and only the one the
  // operator actually pressed should regain focus.
  const openCreate = () => {
    setCreateOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setCreateOpen(true);
  };

  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="Provider Catalog"
        description="Everything this router can reach. Open one to attach credentials, or add an endpoint of your own."
        actions={
          <Button onClick={openCreate}>
            <Plus aria-hidden="true" className="size-4" />
            Add provider
          </Button>
        }
      />

      <div className="@container flex flex-col gap-5">
        <CatalogToolbar
          filters={{ search, category, status, tier }}
          count={count}
          onSearchChange={setSearch}
          onCategoryChange={setCategory}
          onStatusChange={setStatus}
          onTierChange={setTier}
          onClear={clear}
        />

        {providers.isPending ? (
          <GridSkeleton />
        ) : providers.isError ? (
          <Card>
            <StateView
              kind="error"
              title="Could not load the catalog"
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
        ) : rows.length === 0 ? (
          <Card>
            <StateView
              kind={narrowed ? 'no-results' : 'empty'}
              title={narrowed ? 'No providers match' : 'No providers yet'}
              description={
                narrowed
                  ? 'Nothing in the catalog matches these filters. Widen them, or clear the search.'
                  : 'The catalog is empty. Add an endpoint of your own to get started.'
              }
              action={
                narrowed ? (
                  <Button variant="secondary" size="sm" onClick={clear}>
                    Clear filters
                  </Button>
                ) : (
                  <Button size="sm" onClick={openCreate}>
                    <Plus aria-hidden="true" className="size-3.5" />
                    Add provider
                  </Button>
                )
              }
            />
          </Card>
        ) : (
          <div className="flex flex-col gap-4">
            <ul className={CATALOG_GRID}>
              {rows.map((provider) => (
                <li key={provider.id} className="flex">
                  <ProviderCard provider={provider} />
                </li>
              ))}
            </ul>

            {providers.hasNextPage ? (
              <div className="flex justify-center">
                <Button
                  variant="secondary"
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
              <p className="text-center text-xs tabular-nums text-text-subtle">
                {formatCount(rows.length)} of {formatCount(total ?? rows.length)} providers
              </p>
            )}
          </div>
        )}
      </div>

      <ByokDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        restoreFocusTo={createOpener}
      />
    </div>
  );
}
