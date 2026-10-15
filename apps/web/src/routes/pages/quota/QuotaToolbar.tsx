import { Search, X } from 'lucide-react';

import { Button } from '@web/components/ui/Button.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SegmentedControl } from '@web/components/ui/SegmentedControl.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatCount } from '@web/lib/format.ts';

import {
  ATTENTION_OPTIONS,
  QUOTA_SORT_OPTIONS,
  filtersActive,
  isQuotaSort,
  type AttentionFilter,
  type QuotaCount,
  type QuotaFilters,
  type QuotaSort,
} from './quota.ts';

/**
 * The quota list's filter bar.
 *
 * Every control writes to the URL rather than to component state, because a
 * filtered view is one worth linking to (RULESET R6.5) — "which providers are
 * running out" is a question an operator asks a colleague by pasting a link. The
 * bar owns no state at all, which is what lets the page keep the URL as the
 * single source of truth for what is on screen.
 *
 * The count is a live region so a screen reader hears the list change size when
 * a filter is applied, rather than having to go and count the cards.
 */

export interface QuotaToolbarProps {
  readonly filters: QuotaFilters;
  readonly sort: QuotaSort;
  /** What to say about the result set — the query's state, not a bare count. */
  readonly count: QuotaCount;
  readonly onSearchChange: (value: string) => void;
  readonly onAttentionChange: (value: AttentionFilter) => void;
  readonly onSortChange: (value: QuotaSort) => void;
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
function countLabel(count: QuotaCount): string {
  switch (count.kind) {
    case 'loading':
      return 'Loading quota…';
    case 'error':
      return '';
    case 'ready':
      return `${formatCount(count.total)} ${count.total === 1 ? 'provider' : 'providers'} tracked`;
  }
}

export function QuotaToolbar({
  filters,
  sort,
  count,
  onSearchChange,
  onAttentionChange,
  onSortChange,
  onClear,
  className,
}: QuotaToolbarProps) {
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
          <SegmentedControl
            value={filters.attention}
            onValueChange={onAttentionChange}
            aria-label="Filter by state"
            options={ATTENTION_OPTIONS}
          />
          <SimpleSelect
            value={sort}
            onValueChange={(next) => {
              if (isQuotaSort(next)) onSortChange(next);
            }}
            options={[...QUOTA_SORT_OPTIONS]}
            aria-label="Sort providers"
            className="w-full @[480px]:w-52"
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
