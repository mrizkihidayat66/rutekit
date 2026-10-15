import { Search, X } from 'lucide-react';

import { Button } from '@web/components/ui/Button.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatCount } from '@web/lib/format.ts';
import type { ListCount } from '@web/lib/list-filters.ts';

/**
 * The filter bar every configuration list in the console shares.
 *
 * Every control writes to the URL rather than to component state, because a
 * narrowed view is worth linking to (RULESET R6.5) and the pages keep the URL as
 * the single source of truth for what is on screen. The bar therefore owns no
 * state and takes no callbacks it does not call.
 *
 * The dropdowns are described rather than fixed, because the lists do not all
 * narrow the same way. The routing lists ask "switched on or off", which the
 * browser can answer from a field it already has. The API-key list asks which
 * lifecycle stage a key is in — a value the server derives, and one it can filter
 * on — so the page passes that vocabulary in. The bar only has to place a select
 * and label it; what the options mean stays with the page that owns them.
 *
 * There is an array of them because some lists narrow on two independent things:
 * the job history by provider *and* status, the proxy pool by protocol *and*
 * health. One filter would have forced those pages to hand-roll a second bar that
 * then drifted from this one.
 *
 * The count is a live region, so a screen reader hears the list change size when
 * a filter is applied instead of having to go and count the rows.
 */

/** One option in the toolbar's dropdown. */
export interface ListFilterOption {
  readonly value: string;
  readonly label: string;
}

export interface ListToolbarFilter {
  readonly value: string;
  readonly options: readonly ListFilterOption[];
  /**
   * Receives the raw select value. Each page narrows it to its own vocabulary,
   * because the select can only ever hand back a string.
   */
  readonly onChange: (value: string) => void;
  /** Names the control for assistive technology, e.g. "Filter by state". */
  readonly label: string;
  /** Extra width classes, for a vocabulary with longer words than "Disabled". */
  readonly widthClassName?: string;
}

export interface ListToolbarProps {
  readonly search: string;
  readonly onSearchChange: (value: string) => void;
  readonly searchPlaceholder: string;
  readonly filters: readonly ListToolbarFilter[];
  readonly count: ListCount;
  /** What the list holds, so the count can name it — "3 combos", "5 aliases". */
  readonly noun: { readonly one: string; readonly many: string };
  /** Whether anything is narrowing the list, so "Clear filters" can appear. */
  readonly narrowed: boolean;
  readonly onClear: () => void;
  readonly className?: string;
}

/**
 * The count line's text. Deliberately empty once the request has failed: the
 * error card below already says what went wrong, and a live region repeating it
 * — or still claiming to load — would only contradict it.
 */
function countLabel(
  count: ListCount,
  noun: { readonly one: string; readonly many: string },
): string {
  switch (count.kind) {
    case 'loading':
      return 'Loading…';
    case 'error':
      return '';
    case 'ready':
      return `${formatCount(count.shown)} of ${formatCount(count.total)} ${count.total === 1 ? noun.one : noun.many}`;
  }
}

export function ListToolbar({
  search,
  onSearchChange,
  searchPlaceholder,
  filters,
  count,
  noun,
  narrowed,
  onClear,
  className,
}: ListToolbarProps) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-col gap-2 @[760px]:flex-row @[760px]:items-center">
        <div className="w-full @[760px]:max-w-xs">
          <Input
            type="search"
            value={search}
            aria-label="Search"
            placeholder={searchPlaceholder}
            autoComplete="off"
            leading={<Search />}
            trailing={
              search === '' ? undefined : (
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
          {filters.map((filter) => (
            <SimpleSelect
              key={filter.label}
              value={filter.value}
              onValueChange={filter.onChange}
              options={filter.options.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              aria-label={filter.label}
              className={cn('w-full @[480px]:w-44', filter.widthClassName)}
            />
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p role="status" aria-live="polite" className="text-xs text-text-muted">
          {countLabel(count, noun)}
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
