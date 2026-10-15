import { Search, X } from 'lucide-react';

import { ACCOUNT_STATE_OPTIONS, isAccountState } from '@web/components/patterns/provider-vocabulary.ts';
import { Button } from '@web/components/ui/Button.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatCount } from '@web/lib/format.ts';

import { filtersActive, type AccountCount, type AccountFilters, type StateFilter } from './accounts.ts';

/**
 * The Accounts page's filter bar.
 *
 * Every control writes to the URL rather than to component state, because a
 * filtered pool is a view worth linking to (RULESET R6.5) — `/accounts?state=
 * banned` is the link an operator pastes when they find a batch of dead keys.
 * The bar owns no state at all, which is what lets the page keep the URL as the
 * single source of truth for what is on screen.
 *
 * The result count is a live region, so a screen reader hears the table change
 * size when a filter is applied rather than having to go and count the rows.
 */

export interface AccountsToolbarProps {
  readonly filters: AccountFilters;
  /** What to say about the result set — the query's state, not a bare count. */
  readonly count: AccountCount;
  readonly providerOptions: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly onSearchChange: (value: string) => void;
  readonly onProviderChange: (value: string) => void;
  readonly onStateChange: (value: StateFilter) => void;
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
function countLabel(count: AccountCount): string {
  switch (count.kind) {
    case 'loading':
      return 'Loading accounts…';
    case 'error':
      return '';
    case 'ready':
      return `${formatCount(count.total)} ${count.total === 1 ? 'account' : 'accounts'}`;
  }
}

export function AccountsToolbar({
  filters,
  count,
  providerOptions,
  onSearchChange,
  onProviderChange,
  onStateChange,
  onClear,
  className,
}: AccountsToolbarProps) {
  const narrowed = filtersActive(filters);

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-col gap-2 @[760px]:flex-row @[760px]:items-center">
        <div className="w-full @[760px]:max-w-xs">
          <Input
            type="search"
            value={filters.search}
            aria-label="Search accounts"
            placeholder="Search label, email or note…"
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
            value={filters.providerId}
            onValueChange={onProviderChange}
            options={[...providerOptions]}
            aria-label="Filter by provider"
            className="w-full @[480px]:w-48"
          />
          <SimpleSelect
            value={filters.state}
            onValueChange={(next) => {
              if (next === 'all' || isAccountState(next)) onStateChange(next);
            }}
            options={[...ACCOUNT_STATE_OPTIONS]}
            aria-label="Filter by state"
            className="w-full @[480px]:w-44"
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
