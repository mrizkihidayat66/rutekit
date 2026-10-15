import { Search, X } from 'lucide-react';

import {
  MODEL_CAPABILITY_OPTIONS,
  MODEL_SOURCE_OPTIONS,
  isModelCapability,
  isModelSource,
} from '@web/components/patterns/model-vocabulary.ts';
import { Button } from '@web/components/ui/Button.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatCount } from '@web/lib/format.ts';

import {
  MIN_CONTEXT_OPTIONS,
  filtersActive,
  isMinContext,
  type CatalogCount,
  type CatalogFilters,
  type CapabilityFilter,
  type SourceFilter,
} from './catalog.ts';

/**
 * The Model Catalog's filter bar.
 *
 * Five controls, because the catalog is asked five different questions: what is
 * this id, what does this provider serve, what can see, what can think, and what
 * can hold my document. Every one writes to the URL rather than to component
 * state (RULESET R6.5) — `/models?capability=vision&minContext=200000` is the
 * link an operator pastes when they find the one model that fits a screenshot
 * and a long transcript.
 *
 * The result count is a live region, so a screen reader hears the table change
 * size when a filter is applied rather than having to go and count the rows.
 */

export interface CatalogToolbarProps {
  readonly filters: CatalogFilters;
  /** What to say about the result set — the query's state, not a bare count. */
  readonly count: CatalogCount;
  readonly providerOptions: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly onSearchChange: (value: string) => void;
  readonly onProviderChange: (value: string) => void;
  readonly onCapabilityChange: (value: CapabilityFilter) => void;
  readonly onSourceChange: (value: SourceFilter) => void;
  readonly onMinContextChange: (value: string) => void;
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
      return 'Loading models…';
    case 'error':
      return '';
    case 'ready':
      return `${formatCount(count.total)} ${count.total === 1 ? 'model' : 'models'}`;
  }
}

export function CatalogToolbar({
  filters,
  count,
  providerOptions,
  onSearchChange,
  onProviderChange,
  onCapabilityChange,
  onSourceChange,
  onMinContextChange,
  onClear,
  className,
}: CatalogToolbarProps) {
  const narrowed = filtersActive(filters);

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-col gap-2 @[760px]:flex-row @[760px]:items-center">
        <div className="w-full @[760px]:max-w-xs">
          <Input
            type="search"
            value={filters.search}
            aria-label="Search models"
            placeholder="Search model id or provider…"
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
            className="w-full @[480px]:w-44"
          />
          <SimpleSelect
            value={filters.capability}
            onValueChange={(next) => {
              if (next === 'all' || isModelCapability(next)) onCapabilityChange(next);
            }}
            options={[...MODEL_CAPABILITY_OPTIONS]}
            aria-label="Filter by capability"
            className="w-full @[480px]:w-40"
          />
          <SimpleSelect
            value={filters.source}
            onValueChange={(next) => {
              if (next === 'all' || isModelSource(next)) onSourceChange(next);
            }}
            options={[...MODEL_SOURCE_OPTIONS]}
            aria-label="Filter by source"
            className="w-full @[480px]:w-36"
          />
          <SimpleSelect
            value={filters.minContext}
            onValueChange={(next) => {
              if (isMinContext(next)) onMinContextChange(next);
            }}
            options={[...MIN_CONTEXT_OPTIONS]}
            aria-label="Filter by context window"
            className="w-full @[480px]:w-40"
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
