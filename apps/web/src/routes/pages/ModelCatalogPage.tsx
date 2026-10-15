import { Package, RefreshCw } from 'lucide-react';
import { Link } from 'react-router';

import type { ModelsQuery } from '@contracts';

import { DataTable } from '@web/components/patterns/DataTable.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { buttonVariants } from '@web/components/ui/button-variants.ts';
import { Card } from '@web/components/ui/Card.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useModels, useProviders } from '@web/hooks/use-providers.ts';
import { useUrlParam, useUrlText } from '@web/hooks/use-url-state.ts';
import { formatCount } from '@web/lib/format.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { CatalogToolbar } from './model-catalog/CatalogToolbar.tsx';
import { catalogColumns } from './model-catalog/catalog-columns.tsx';
import {
  CAPABILITY_VALUES,
  CATALOG_DIRECTIONS,
  CATALOG_PAGE_SIZE,
  CATALOG_SORT_KEYS,
  DEFAULT_CATALOG_DIRECTION,
  DEFAULT_CATALOG_SORT,
  MIN_CONTEXT_CHOICES,
  SOURCE_VALUES,
  filtersActive,
  isCatalogDirection,
  isCatalogSortKey,
  minContextValue,
  type CapabilityFilter,
  type CatalogCount,
  type CatalogSortKey,
  type CatalogDirection,
  type SourceFilter,
} from './model-catalog/catalog.ts';

/**
 * The Model Catalog: every model from every provider, in one table.
 *
 * Provider Detail answers "what does this endpoint serve"; this answers the
 * question that crosses providers — which id do I put in a config, and which of
 * the things that offer it can hold my document. That makes it the console's
 * lookup table, so it is read-only by design: an operator browses and copies
 * here, and any edit to a model happens on the provider that owns it, which is
 * one click away through the Provider column.
 *
 * The filters are the five questions an operator arrives with, and they live in
 * the URL (RULESET R6.5), so `/models?capability=vision&minContext=200000` is a
 * link worth pasting. The table is the page; there is no summary above it,
 * because the toolbar's count already answers "how many".
 */

/** How many placeholder rows to draw while the first page is in flight. */
const SKELETON_ROWS = 10;

/** Eight columns, in the order the table declares them. */
const SKELETON_COLUMN_WIDTHS = ['w-32', 'w-24', 'w-14', 'w-14', 'w-14', 'w-20', 'w-14', 'w-14'];

/** Built once: nothing in the table depends on the page's state. */
const COLUMNS = catalogColumns();

function TableSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading models" className="@container">
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

export function ModelCatalogPage() {
  const [search, setSearch] = useUrlText('q');
  const [providerId, setProviderId] = useUrlParam<string>('providerId', '');
  const [capability, setCapability] = useUrlParam<CapabilityFilter>(
    'capability',
    'all',
    CAPABILITY_VALUES,
  );
  const [source, setSource] = useUrlParam<SourceFilter>('source', 'all', SOURCE_VALUES);
  const [minContext, setMinContext] = useUrlParam<string>('minContext', '', MIN_CONTEXT_CHOICES);
  const [sortKey, setSortKey] = useUrlParam<CatalogSortKey>(
    'sort',
    DEFAULT_CATALOG_SORT,
    CATALOG_SORT_KEYS,
  );
  const [direction, setDirection] = useUrlParam<CatalogDirection>(
    'direction',
    DEFAULT_CATALOG_DIRECTION,
    CATALOG_DIRECTIONS,
  );

  const query: Omit<ModelsQuery, 'cursor'> = {
    q: search,
    providerId: providerId === '' ? null : providerId,
    capability: capability === 'all' ? null : capability,
    source: source === 'all' ? null : source,
    minContext: minContextValue(minContext),
    sort: sortKey,
    direction,
    limit: CATALOG_PAGE_SIZE,
  };

  const models = useModels(query);
  const rows = (models.data?.pages ?? []).flatMap((page) => page.items);
  const total = models.data?.pages[0]?.total ?? null;

  // The provider list only feeds the filter, so it is fetched once and sorted by
  // name rather than paged: it is the small fixed set of configured endpoints.
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

  const narrowed = filtersActive({ search, providerId, capability, source, minContext });

  const count: CatalogCount = models.isPending
    ? { kind: 'loading' }
    : models.isError
      ? { kind: 'error' }
      : { kind: 'ready', total: total ?? rows.length };

  const clear = () => {
    setSearch('');
    setProviderId('');
    setCapability('all');
    setSource('all');
    setMinContext('');
  };

  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="Model Catalog"
        description="Every model from every provider. Filter by capability or context, then copy an id straight into a config."
      />

      <div className="@container flex flex-col gap-4">
        <CatalogToolbar
          filters={{ search, providerId, capability, source, minContext }}
          count={count}
          providerOptions={[
            { value: '', label: 'All providers' },
            ...providers.map((provider) => ({ value: provider.id, label: provider.name })),
          ]}
          onSearchChange={setSearch}
          onProviderChange={setProviderId}
          onCapabilityChange={setCapability}
          onSourceChange={setSource}
          onMinContextChange={setMinContext}
          onClear={clear}
        />

        {models.isPending ? (
          <TableSkeleton />
        ) : models.isError ? (
          <Card>
            <StateView
              kind="error"
              title="Could not load the catalog"
              description="The console API did not answer. Check that the server is running, then try again."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  loading={models.isFetching}
                  onClick={() => {
                    void models.refetch();
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
            columns={COLUMNS}
            getRowId={(row) => `${row.providerId}/${row.id}`}
            caption="Every model available across providers"
            sort={{ key: sortKey, direction }}
            onSortChange={(next) => {
              if (next.key !== null && isCatalogSortKey(next.key)) setSortKey(next.key);
              if (isCatalogDirection(next.direction)) setDirection(next.direction);
            }}
            emptyState={
              <StateView
                kind={narrowed ? 'no-results' : 'empty'}
                title={narrowed ? 'No models match' : 'The catalog is empty'}
                description={
                  narrowed
                    ? 'Nothing in the catalog matches these filters. Widen them, or clear the search.'
                    : 'No provider is serving any model yet. Add a provider and fetch its model list, and its models will appear here.'
                }
                action={
                  narrowed ? (
                    <Button variant="secondary" size="sm" onClick={clear}>
                      Clear filters
                    </Button>
                  ) : (
                    <Link to="/providers" className={buttonVariants({ variant: 'primary', size: 'sm' })}>
                      <Package aria-hidden="true" className="size-3.5" />
                      Provider Catalog
                    </Link>
                  )
                }
              />
            }
            footer={
              models.hasNextPage ? (
                <div className="flex justify-center py-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={models.isFetchingNextPage}
                    onClick={() => {
                      void models.fetchNextPage();
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
                  {formatCount(rows.length)} of {formatCount(total ?? rows.length)} models
                </p>
              )
            }
          />
        )}
      </div>
    </div>
  );
}
