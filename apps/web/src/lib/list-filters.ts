/**
 * Filter vocabulary shared by the console's list pages.
 *
 * Nearly every list in the console narrows the same two ways: a free-text search
 * and a tri-state "is it switched on" filter. Both are applied in the browser
 * rather than by the endpoint — the list endpoints take the shared search query
 * and nothing else — and these lists are configuration, so they run to dozens of
 * rows and the browser narrows them exactly and for free.
 *
 * Kept out of any component file so the toolbar and the pages that use it can
 * import the same words without breaking fast refresh.
 */

export const ENABLED_FILTERS = ['all', 'enabled', 'disabled'] as const;
export type EnabledFilter = (typeof ENABLED_FILTERS)[number];

export const ENABLED_LABELS: Record<EnabledFilter, string> = {
  all: 'Any state',
  enabled: 'Enabled only',
  disabled: 'Disabled only',
};

export const ENABLED_OPTIONS: readonly {
  readonly value: EnabledFilter;
  readonly label: string;
}[] = ENABLED_FILTERS.map((value) => ({ value, label: ENABLED_LABELS[value] }));

export function isEnabledFilter(value: string): value is EnabledFilter {
  return ENABLED_FILTERS.includes(value as EnabledFilter);
}

/** Whether a record's `enabled` flag passes the filter. */
export function matchesEnabled(enabled: boolean, filter: EnabledFilter): boolean {
  if (filter === 'all') return true;
  return filter === 'enabled' ? enabled : !enabled;
}

/** True when the search box or the state filter is narrowing the list. */
export function listNarrowed(search: string, filter: EnabledFilter): boolean {
  return search !== '' || filter !== 'all';
}

/**
 * What a list's count line should say.
 *
 * A bare `number | null` cannot tell "still loading" from "the request failed",
 * and those want different words — a live region still claiming to load while an
 * error card sits beneath it contradicts what the operator can see.
 */
export type ListCount =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly shown: number; readonly total: number };
