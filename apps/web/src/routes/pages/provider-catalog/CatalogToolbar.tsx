import { Search, X } from 'lucide-react';

import {
  PROVIDER_CATEGORY_OPTIONS,
  PROVIDER_STATUS_OPTIONS,
  isProviderCategory,
  isProviderStatus,
} from '@web/components/patterns/provider-vocabulary.ts';
import { Button } from '@web/components/ui/Button.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SegmentedControl } from '@web/components/ui/SegmentedControl.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatCount } from '@web/lib/format.ts';

import {
  TIER_OPTIONS,
  filtersActive,
  type CatalogCount,
  type CatalogFilters,
  type CategoryFilter,
  type StatusFilter,
  type Tier,
} from './catalog.ts';

/**
 * The catalog's filter bar.
 *
 * Every control here writes to the URL rather than to component state, because a
 * filtered catalog is a view worth linking to (RULESET R6.5). The bar owns no
 * state at all — it takes the current filters and reports changes — which is what
 * lets the page keep the URL as the single source of truth for what is on screen.
 *
 * The result count is a live region so a screen reader hears the grid change
 * size when a filter is applied, rather than having to go and count the cards.
 */

export interface CatalogToolbarProps {
  readonly filters: CatalogFilters;
  /** What to say about the result set — the query's state, not a bare count. */
  readonly count: CatalogCount;
  readonly onSearchChange: (value: string) => void;
  readonly onCategoryChange: (value: CategoryFilter) => void;
  readonly onStatusChange: (value: StatusFilter) => void;
  readonly onTierChange: (value: Tier) => void;
  readonly onClear: () => void;
  readonly className?: string;
}

/**
 * The count line's text.
 *
 * Deliberately empty once the request has failed. The error card below already
 * says what went wrong; a live region repeating it, or still claiming to load,
 * would only contradict it.
 */
function countLabel(count: CatalogCount): string {
  switch (count.kind) {
    case 'loading':
      return 'Loading providers…';
    case 'error':
      return '';
    case 'ready':
      return `${formatCount(count.total)} ${count.total === 1 ? 'provider' : 'providers'}`;
  }
}

export function CatalogToolbar({
  filters,
  count,
  onSearchChange,
  onCategoryChange,
  onStatusChange,
  onTierChange,
  onClear,
  className,
}: CatalogToolbarProps) {
  const narrowed = filtersActive(filters);

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-col gap-2 @[720px]:flex-row @[720px]:items-center">
        <div className="w-full @[720px]:max-w-xs">
          <Input
            type="search"
            value={filters.search}
            aria-label="Search providers"
            placeholder="Search providers…"
            autoComplete="off"
            leading={<Search />}
            trailing={
              filters.search === '' ? undefined : (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => {
                    onSearchChange('');
                  }}
                  className="rounded-control p-0.5 transition duration-(--dur-micro) ease-out outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <X aria-hidden="true" />
                </button>
              )
            }
            onChange={(event) => {
              onSearchChange(event.target.value);
            }}
          />
        </div>

        <div className="flex flex-1 flex-wrap items-center gap-2">
          <SimpleSelect
            value={filters.category}
            onValueChange={(next) => {
              if (next === 'all' || isProviderCategory(next)) onCategoryChange(next);
            }}
            options={[...PROVIDER_CATEGORY_OPTIONS]}
            aria-label="Filter by category"
            className="w-full @[480px]:w-44"
          />
          <SimpleSelect
            value={filters.status}
            onValueChange={(next) => {
              if (next === 'all' || isProviderStatus(next)) onStatusChange(next);
            }}
            options={[...PROVIDER_STATUS_OPTIONS]}
            aria-label="Filter by status"
            className="w-full @[480px]:w-40"
          />
          <SegmentedControl
            value={filters.tier}
            onValueChange={onTierChange}
            aria-label="Filter by price"
            options={TIER_OPTIONS}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p role="status" aria-live="polite" className="text-xs text-text-muted">
          {countLabel(count)}
        </p>
        {narrowed ? (
          <Button variant="ghost" size="sm" onClick={onClear}>
            <X aria-hidden="true" className="size-3.5" />
            Clear filters
          </Button>
        ) : null}
      </div>
    </div>
  );
}
