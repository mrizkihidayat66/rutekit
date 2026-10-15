import { MODEL_CAPABILITIES, type ModelCapability, type ModelSource } from '@contracts';

import { MODEL_SOURCES } from '@web/components/patterns/model-vocabulary.ts';

/**
 * The Model Catalog's vocabulary.
 *
 * The catalog answers one question — "which provider serves this id, and what
 * does it cost" — so everything here is about narrowing the list to the answer.
 * The filter values, the sortable fields and the page size live in this file
 * rather than in the page so the URL parser, the toolbar and the table cannot
 * disagree about what a given query string means. Nothing here renders, which
 * keeps it importable from any of the page's components without breaking fast
 * refresh.
 */

export type SourceFilter = 'all' | ModelSource;
export type CapabilityFilter = 'all' | ModelCapability;

/**
 * The values `useUrlParam` will accept back out of the address bar, derived from
 * the same lists the selects are built from so a hand-edited URL cannot select
 * a filter the toolbar has no way to display or clear.
 */
export const CAPABILITY_VALUES: readonly CapabilityFilter[] = ['all', ...MODEL_CAPABILITIES];
export const SOURCE_VALUES: readonly SourceFilter[] = ['all', ...MODEL_SOURCES];

/**
 * Fields the catalog endpoint can order by.
 *
 * Deliberately short. The endpoint would accept any field name, but `createdAt`
 * and `updatedAt` would sit next to each other and be called different columns
 * when they are not, and `id` orders the same way `displayName` mostly does.
 * What is left is the four things an operator actually compares models on, plus
 * the provider they belong to.
 */
export const CATALOG_SORT_KEYS = [
  'displayName',
  'providerName',
  'contextWindow',
  'maxOutputTokens',
  'inputPricePerMTok',
] as const;
export type CatalogSortKey = (typeof CATALOG_SORT_KEYS)[number];

/** Alphabetical: a catalog is browsed by name, not by recency. */
export const DEFAULT_CATALOG_SORT: CatalogSortKey = 'displayName';

export const CATALOG_DIRECTIONS = ['asc', 'desc'] as const;
export type CatalogDirection = (typeof CATALOG_DIRECTIONS)[number];

export const DEFAULT_CATALOG_DIRECTION: CatalogDirection = 'asc';

export function isCatalogSortKey(value: string): value is CatalogSortKey {
  return CATALOG_SORT_KEYS.includes(value as CatalogSortKey);
}

export function isCatalogDirection(value: string): value is CatalogDirection {
  return CATALOG_DIRECTIONS.includes(value as CatalogDirection);
}

/**
 * Forty rows a page. The catalog is the largest list in the console — every
 * provider's every model — so the first page is deliberately not the whole
 * thing; "Load more" is how an operator walks it.
 */
export const CATALOG_PAGE_SIZE = 40;

/**
 * The context floor, as a picker.
 *
 * A floor rather than a range: an operator filtering context is asking "what can
 * hold my document", and a single threshold is one control and one URL parameter
 * where two bounds would be four. The values are the round numbers models are
 * actually sold at, so the picker offers the sizes an operator recognises rather
 * than an arbitrary number box.
 *
 * The stored value is a string because it travels in the URL; `minContextValue`
 * turns it back into the number the endpoint takes.
 */
export const MIN_CONTEXT_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: '', label: 'Any context' },
  { value: '8000', label: '8K or more' },
  { value: '32000', label: '32K or more' },
  { value: '128000', label: '128K or more' },
  { value: '200000', label: '200K or more' },
  { value: '1000000', label: '1M or more' },
];

/** The stored floors, for the URL parser and the select's allowed values. */
export const MIN_CONTEXT_CHOICES: readonly string[] = MIN_CONTEXT_OPTIONS.map(
  (option) => option.value,
);

export function isMinContext(value: string): boolean {
  return MIN_CONTEXT_CHOICES.includes(value);
}

/** The URL's floor as the number the endpoint wants, or `null` for no floor. */
export function minContextValue(minContext: string): number | null {
  const parsed = Number.parseInt(minContext, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export interface CatalogFilters {
  readonly search: string;
  /** Provider slug, or `''` for every provider. */
  readonly providerId: string;
  readonly capability: CapabilityFilter;
  readonly source: SourceFilter;
  /** One of `MIN_CONTEXT_OPTIONS`' values, or `''` for no floor. */
  readonly minContext: string;
}

/** True when anything is narrowing the table, so the page can offer to clear it. */
export function filtersActive(filters: CatalogFilters): boolean {
  return (
    filters.search !== '' ||
    filters.providerId !== '' ||
    filters.capability !== 'all' ||
    filters.source !== 'all' ||
    filters.minContext !== ''
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
