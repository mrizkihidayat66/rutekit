import type { ProviderCategory, ProviderStatus, ProvidersQuery } from '@contracts';

import {
  PROVIDER_CATEGORY_OPTIONS,
  PROVIDER_STATUS_OPTIONS,
} from '@web/components/patterns/provider-vocabulary.ts';

/**
 * The catalog page's vocabulary.
 *
 * The filter values, their allowed sets and the grid's shape live here rather
 * than in the page, so the URL parser, the toolbar and the grid cannot disagree
 * about what "free" means. Nothing here renders, which keeps it importable from
 * any of the page's components without breaking fast refresh.
 */

/** The catalog's tri-state price filter. */
export type Tier = ProvidersQuery['tier'];

export const TIERS = ['all', 'free', 'paid'] as const satisfies readonly Tier[];

export const TIER_LABELS: Record<Tier, string> = {
  all: 'All',
  free: 'Free tier',
  paid: 'Paid',
};

export const TIER_OPTIONS = TIERS.map((tier) => ({ value: tier, label: TIER_LABELS[tier] }));

export const DEFAULT_TIER: Tier = 'all';

export type CategoryFilter = 'all' | ProviderCategory;
export type StatusFilter = 'all' | ProviderStatus;

/** The values `useUrlParam` will accept back out of the address bar. */
export const CATEGORY_VALUES: readonly CategoryFilter[] = PROVIDER_CATEGORY_OPTIONS.map(
  (option) => option.value,
);
export const STATUS_VALUES: readonly StatusFilter[] = PROVIDER_STATUS_OPTIONS.map(
  (option) => option.value,
);

/**
 * Twenty-four to a page — six rows of the four-column grid at its widest, and
 * a whole number of rows at every narrower step too, so "Load more" never
 * leaves a ragged half-row behind.
 */
export const CATALOG_PAGE_SIZE = 24;

/**
 * The grid.
 *
 * Columns follow the *container*, not the viewport (RULESET R3.6): the catalog
 * is rendered inside a shell whose sidebar may be collapsed, so the width that
 * matters is the one the grid was actually given. One column on a phone, two on
 * a tablet, four on a wide console.
 */
export const CATALOG_GRID =
  'grid grid-cols-1 gap-3 @[520px]:grid-cols-2 @[920px]:grid-cols-3 @[1320px]:grid-cols-4';

export interface CatalogFilters {
  readonly search: string;
  readonly category: CategoryFilter;
  readonly status: StatusFilter;
  readonly tier: Tier;
}

/** True when anything is narrowing the grid, so the page can offer to clear it. */
export function filtersActive(filters: CatalogFilters): boolean {
  return (
    filters.search !== '' ||
    filters.category !== 'all' ||
    filters.status !== 'all' ||
    filters.tier !== 'all'
  );
}

/**
 * What the toolbar's result-count line should say.
 *
 * A bare `number | null` cannot tell "still loading" from "the request failed",
 * and those need different words — a live region still claiming to load while an
 * error card sits beneath it contradicts what the operator can plainly see.
 */
export type CatalogCount =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly total: number };
