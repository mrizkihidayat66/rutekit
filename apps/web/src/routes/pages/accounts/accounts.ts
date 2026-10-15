import type { AccountState } from '@contracts';

import { ACCOUNT_STATE_OPTIONS } from '@web/components/patterns/provider-vocabulary.ts';

/**
 * The Accounts page's vocabulary.
 *
 * The filter values, the sortable fields and the page size live here rather than
 * in the page, so the URL parser, the toolbar and the table cannot disagree
 * about what a given query string means. Nothing here renders, which keeps it
 * importable from any of the page's components without breaking fast refresh.
 */

export type StateFilter = 'all' | AccountState;

/** The values `useUrlParam` will accept back out of the address bar. */
export const STATE_VALUES: readonly StateFilter[] = ACCOUNT_STATE_OPTIONS.map((option) => option.value);

/**
 * Fields the list endpoint can order by. These are the ones an operator actually
 * sorts on — the endpoint would accept any field name, but offering all of them
 * would put `createdAt` and `updatedAt` next to each other and call them
 * different columns when they are not.
 */
export const ACCOUNT_SORT_KEYS = ['label', 'state', 'inFlight', 'lastUsedAt'] as const;
export type AccountSortKey = (typeof ACCOUNT_SORT_KEYS)[number];

export const DEFAULT_ACCOUNT_SORT: AccountSortKey = 'lastUsedAt';

export const ACCOUNT_DIRECTIONS = ['asc', 'desc'] as const;
export type AccountDirection = (typeof ACCOUNT_DIRECTIONS)[number];

/** Most recently used first — the order an operator triaging a pool wants. */
export const DEFAULT_ACCOUNT_DIRECTION: AccountDirection = 'desc';

export function isAccountSortKey(value: string): value is AccountSortKey {
  return ACCOUNT_SORT_KEYS.includes(value as AccountSortKey);
}

export function isAccountDirection(value: string): value is AccountDirection {
  return ACCOUNT_DIRECTIONS.includes(value as AccountDirection);
}

/**
 * Forty rows a page. The pool runs to a few dozen credentials, so the first page
 * is usually the whole thing; the cap exists so a thousand-account import still
 * renders in one frame.
 */
export const ACCOUNT_PAGE_SIZE = 40;

export interface AccountFilters {
  readonly search: string;
  /** Provider slug, or `''` for the whole pool. */
  readonly providerId: string;
  readonly state: StateFilter;
}

/** True when anything is narrowing the table, so the page can offer to clear it. */
export function filtersActive(filters: AccountFilters): boolean {
  return filters.search !== '' || filters.providerId !== '' || filters.state !== 'all';
}

/**
 * What the toolbar's result-count line should say.
 *
 * A bare `number | null` cannot tell "still loading" from "the request failed",
 * and those need different words — a live region still claiming to load while an
 * error card sits beneath it contradicts what the operator can plainly see.
 */
export type AccountCount =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly total: number };

/**
 * The bulk actions, in the order the bar offers them.
 *
 * Ordered by how often they are needed and how safe they are: the reversible
 * recovery actions first, then the two that need asking about, deletion last and
 * set apart — so the destructive button is never the one under the cursor when
 * the bar appears.
 *
 * `confirm` is separate from `destructive` because the two are not the same
 * question. Rotating a credential destroys nothing, but it does swap the secret
 * the pool is holding, and an operator who fumbled a selection should get a
 * second look before that happens. Only `delete` is coloured as danger.
 */
export const BULK_ACTIONS = [
  { id: 'enable', label: 'Enable', destructive: false, confirm: false },
  { id: 'disable', label: 'Disable', destructive: false, confirm: false },
  { id: 'reset_cooldown', label: 'Reset cooldown', destructive: false, confirm: false },
  { id: 'reset_failures', label: 'Reset failures', destructive: false, confirm: false },
  { id: 'rotate', label: 'Rotate', destructive: false, confirm: true },
  { id: 'delete', label: 'Delete', destructive: true, confirm: true },
] as const satisfies readonly {
  readonly id: string;
  readonly label: string;
  readonly destructive: boolean;
  readonly confirm: boolean;
}[];

export type BulkActionId = (typeof BULK_ACTIONS)[number]['id'];

/** What a confirming action should ask before it runs. */
export const BULK_CONFIRMATIONS: Record<BulkActionId, { readonly title: string; readonly body: string }> = {
  enable: { title: 'Enable accounts', body: 'They rejoin the rotation immediately.' },
  disable: { title: 'Disable accounts', body: 'They leave the rotation until you enable them again.' },
  reset_cooldown: { title: 'Reset cooldown', body: 'They become routable at once.' },
  reset_failures: { title: 'Reset failures', body: 'Their backoff counters start from zero.' },
  rotate: {
    title: 'Rotate credentials',
    body: 'Each account is re-authenticated and its stored secret is replaced. The old secret cannot be recovered.',
  },
  delete: {
    title: 'Delete accounts',
    body: 'The credentials and their history are removed for good. This cannot be undone.',
  },
};

/** A bulk action's row of the vocabulary, by id. */
export function bulkAction(id: BulkActionId): (typeof BULK_ACTIONS)[number] {
  const found = BULK_ACTIONS.find((action) => action.id === id);
  // The list is exhaustive by construction, so this only runs if `id` was cast.
  if (found === undefined) throw new Error(`Unknown bulk action: ${id}`);
  return found;
}
