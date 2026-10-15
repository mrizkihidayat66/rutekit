import { RefreshCw } from 'lucide-react';
import { useMemo } from 'react';

import { ResetCountdown } from '@web/components/patterns/ResetCountdown.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useCheckQuota, useProviders, useQuota } from '@web/hooks/use-providers.ts';
import { useUrlParam, useUrlText } from '@web/hooks/use-url-state.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { QuotaProviderCard } from './quota/QuotaProviderCard.tsx';
import { QuotaToolbar } from './quota/QuotaToolbar.tsx';
import {
  ATTENTION_VALUES,
  DEFAULT_QUOTA_SORT,
  QUOTA_GRID,
  QUOTA_SORTS,
  filterRows,
  filtersActive,
  sortRows,
  type AttentionFilter,
  type QuotaCount,
  type QuotaSort,
} from './quota/quota.ts';

/**
 * Quota Management: what each provider has left, and when it comes back.
 *
 * The catalog answers "what can this router reach"; this page answers "how much
 * of it is left". That is a question with a deadline attached — a window that is
 * nearly spent refills on a schedule — so the page is built around the two
 * things an operator watches: the check-in state (is a fresh figure on its way?)
 * and the countdown to the next reset.
 *
 * The whole overview arrives in one response, so filtering and ordering happen
 * on the client and land in the URL, which is what makes `?attention=attention`
 * a link worth pasting to say "these are the ones running out".
 */

/** How many placeholder cards to draw while the first read is in flight. */
const SKELETON_COUNT = 6;

function GridSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading quota" className={QUOTA_GRID}>
      {Array.from({ length: SKELETON_COUNT }, (_, index) => (
        <Card key={index} className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Skeleton shape="block" className="size-8 rounded-control" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton shape="text" className="w-24" />
              <Skeleton shape="text" className="w-16" />
            </div>
          </div>
          <Skeleton shape="block" className="h-14 rounded-control" />
          <Skeleton shape="block" className="h-14 rounded-control" />
        </Card>
      ))}
    </div>
  );
}

export function QuotaPage() {
  const [search, setSearch] = useUrlText('q');
  const [attention, setAttention] = useUrlParam<AttentionFilter>(
    'attention',
    'all',
    ATTENTION_VALUES,
  );
  const [sort, setSort] = useUrlParam<QuotaSort>('sort', DEFAULT_QUOTA_SORT, QUOTA_SORTS);

  const quota = useQuota();
  const checkIn = useCheckQuota();

  // The overview carries a provider's name but not its icon, so the catalog is
  // read once for the slug each card draws. It is a small fixed list, so it is
  // fetched whole and sorted by name rather than paged like the catalog page.
  const catalog = useProviders({
    q: '',
    category: null,
    status: null,
    tier: 'all',
    sort: 'name',
    direction: 'asc',
    limit: 200,
  });
  const iconById = useMemo(
    () =>
      new Map(
        (catalog.data?.pages ?? [])
          .flatMap((page) => page.items)
          .map((provider) => [provider.id, provider.icon]),
      ),
    [catalog.data],
  );

  const visible = useMemo(
    () => sortRows(filterRows(quota.data?.rows ?? [], { search, attention }), sort),
    [quota.data, search, attention, sort],
  );

  const narrowed = filtersActive({ search, attention });
  const nextSweep = quota.data?.nextSweepInSeconds ?? null;

  const count: QuotaCount = quota.isPending
    ? { kind: 'loading' }
    : quota.isError
      ? { kind: 'error' }
      : { kind: 'ready', total: quota.data.rows.length };

  // The card being checked in, so only that one shows a spinner. A sweep of every
  // provider carries an empty list, and the header button reports that instead.
  const busyProviderId =
    checkIn.isPending && checkIn.variables !== undefined
      ? (checkIn.variables.providerIds[0] ?? null)
      : null;
  const checkingAll = checkIn.isPending && (checkIn.variables?.providerIds.length ?? -1) === 0;

  const clear = () => {
    setSearch('');
    setAttention('all');
  };

  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="Quota Management"
        description="What each provider has left to spend, and when it refills. Check a provider in to pull a fresh figure."
        actions={
          <Button
            loading={checkingAll}
            onClick={() => {
              checkIn.mutate({ providerIds: [] });
            }}
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Check in all
          </Button>
        }
      />

      <div className="@container flex flex-col gap-5">
        <QuotaToolbar
          filters={{ search, attention }}
          sort={sort}
          count={count}
          onSearchChange={setSearch}
          onAttentionChange={setAttention}
          onSortChange={setSort}
          onClear={clear}
        />

        {nextSweep === null ? null : (
          <p className="-mt-2 text-xs text-text-subtle">
            Next automatic sweep in <ResetCountdown seconds={nextSweep} />
          </p>
        )}

        {quota.isPending ? (
          <GridSkeleton />
        ) : quota.isError ? (
          <Card>
            <StateView
              kind="error"
              title="Could not load quota"
              description="The console API did not answer. Check that the server is running, then try again."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  loading={quota.isFetching}
                  onClick={() => {
                    void quota.refetch();
                  }}
                >
                  <RefreshCw aria-hidden="true" className="size-3.5" />
                  Retry
                </Button>
              }
            />
          </Card>
        ) : visible.length === 0 ? (
          <Card>
            <StateView
              kind={narrowed ? 'no-results' : 'empty'}
              title={narrowed ? 'No providers match' : 'Nothing to track'}
              description={
                narrowed
                  ? 'Nothing matches these filters. Widen them, or clear the search.'
                  : 'No provider reports a quota window or a credit balance yet. Attach a credential and check one in.'
              }
              action={
                narrowed ? (
                  <Button variant="secondary" size="sm" onClick={clear}>
                    Clear filters
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    loading={checkingAll}
                    onClick={() => {
                      checkIn.mutate({ providerIds: [] });
                    }}
                  >
                    <RefreshCw aria-hidden="true" className="size-3.5" />
                    Check in all
                  </Button>
                )
              }
            />
          </Card>
        ) : (
          <ul className={QUOTA_GRID}>
            {visible.map((row) => (
              // A plain grid item, so the card stretches to the cell the same way
              // the skeletons above do. Wrapping it in a flex row made the card a
              // flex item sized to its own content, and cards then came out at
              // whatever width their longest line happened to need.
              <li key={row.providerId}>
                <QuotaProviderCard
                  row={row}
                  icon={iconById.get(row.providerId) ?? 'box'}
                  busy={busyProviderId === row.providerId}
                  onCheckIn={(providerId) => {
                    checkIn.mutate({ providerIds: [providerId] });
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
