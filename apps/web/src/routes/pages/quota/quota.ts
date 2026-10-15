import type { QuotaRow, QuotaWindow } from '@contracts';

import { formatSpan } from '@web/lib/format.ts';

/**
 * The Quota Management page's vocabulary.
 *
 * Everything the page needs to agree with itself about lives here: how a window
 * is named, when a provider counts as "needs attention", and how the list is
 * ordered. Nothing renders, so the URL parser, the toolbar, the cards and the
 * sort can share it without breaking fast refresh.
 *
 * The endpoint returns the whole overview in one response — there is no cursor
 * in `quotaOverviewSchema` — so ordering and filtering happen here, on the
 * client, rather than being round-tripped to the server.
 */

/**
 * The orderings on offer.
 *
 * Key and direction are one choice rather than two controls, because every
 * combination an operator wants has a name — "most used", "longest since
 * checked" — and none of them want the fourth one that a free pair would allow.
 */
export type QuotaSort =
  | 'usage_desc'
  | 'usage_asc'
  | 'name_asc'
  | 'name_desc'
  | 'checked_desc'
  | 'checked_asc';

export const QUOTA_SORTS = [
  'usage_desc',
  'usage_asc',
  'name_asc',
  'name_desc',
  'checked_desc',
  'checked_asc',
] as const satisfies readonly QuotaSort[];

export const QUOTA_SORT_LABELS: Record<QuotaSort, string> = {
  usage_desc: 'Most used',
  usage_asc: 'Least used',
  name_asc: 'Name A–Z',
  name_desc: 'Name Z–A',
  checked_desc: 'Recently checked',
  checked_asc: 'Longest since checked',
};

export const QUOTA_SORT_OPTIONS = QUOTA_SORTS.map((sort) => ({
  value: sort,
  label: QUOTA_SORT_LABELS[sort],
}));

/** Worst-first by default: the page exists to surface what is running out. */
export const DEFAULT_QUOTA_SORT: QuotaSort = 'usage_desc';

export function isQuotaSort(value: string): value is QuotaSort {
  return (QUOTA_SORTS as readonly string[]).includes(value);
}

/** The attention filter, as a segmented control. */
export type AttentionFilter = 'all' | 'attention';

export const ATTENTION_VALUES = ['all', 'attention'] as const satisfies readonly AttentionFilter[];

export const ATTENTION_OPTIONS = [
  { value: 'all' as const, label: 'All providers' },
  { value: 'attention' as const, label: 'Needs attention' },
];

export interface QuotaFilters {
  readonly search: string;
  readonly attention: AttentionFilter;
}

/** True when anything is narrowing the list, so the page can offer to clear it. */
export function filtersActive(filters: QuotaFilters): boolean {
  return filters.search !== '' || filters.attention !== 'all';
}

/**
 * What the toolbar's count line should say.
 *
 * A bare `number | null` cannot tell "still loading" from "the request failed",
 * and a live region still claiming to load while an error card sits beneath it
 * contradicts what the operator can plainly see.
 */
export type QuotaCount =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly total: number };

/**
 * The card grid.
 *
 * Columns follow the *container*, not the viewport (RULESET R3.6) — the console's
 * sidebar may be collapsed, so the width that matters is the one the grid was
 * given. A quota card is taller than a catalog card (it stacks a line per window
 * and per pool), so it stops at three columns where the catalog goes to four.
 *
 * `auto-rows-fr` gives every row the height of the tallest card. Without it each
 * row sizes to its own content, so a provider metering one window sits short
 * beside one metering three and the list reads as ragged rather than as a table
 * of like things.
 */
export const QUOTA_GRID =
  'grid auto-rows-fr grid-cols-1 gap-3 @[560px]:grid-cols-2 @[880px]:grid-cols-3';

/**
 * A quota window's length, in words — `per hour`, `per day`, `per 6 hours`.
 *
 * The contract carries seconds, not a label, because a provider may meter on any
 * period it likes. Named periods get their name; anything else falls back to the
 * same span formatting the rest of the console uses, so an unusual window reads
 * as a duration rather than as a raw number of seconds.
 */
export function windowLabel(seconds: number): string {
  switch (seconds) {
    case 60:
      return 'per minute';
    case 3_600:
      return 'per hour';
    case 21_600:
      return 'per 6 hours';
    case 86_400:
      return 'per day';
    case 604_800:
      return 'per week';
    default:
      return `per ${formatSpan(seconds)}`;
  }
}

/** How much of a window is spent, as `0..1`. */
export function windowUsage(window: QuotaWindow): number {
  return window.limit > 0 ? (window.limit - window.remaining) / window.limit : 0;
}

/** The threshold at which a provider is worth flagging on this page. */
const ATTENTION_RATIO = 0.8;

/**
 * A row's worst window or pool, as `0..1`.
 *
 * The maximum, not an average: one exhausted window blocks routing even if every
 * other window is untouched, so the page must rank by the binding constraint
 * rather than by a mean that hides it.
 */
export function rowUsage(row: QuotaRow): number {
  const ratios = [
    ...row.windows.map(windowUsage),
    ...row.creditPools.map((pool) =>
      pool.totalCredits > 0 ? pool.usedCredits / pool.totalCredits : 0,
    ),
  ];
  return ratios.length === 0 ? 0 : Math.max(...ratios);
}

/** Whether this provider has anything worth an operator's attention. */
export function needsAttention(row: QuotaRow): boolean {
  if (row.checking) return true;
  return rowUsage(row) >= ATTENTION_RATIO;
}

/**
 * Whether a row is waiting on a reset — nearly spent, with a refill scheduled.
 *
 * This is the state the sheen marks. It is deliberately narrower than "nearly
 * spent": a paid balance that will never refill is not waiting on anything, and
 * animating it would promise a reset that is not coming.
 */
export function waitingOnReset(ratio: number, hasSchedule: boolean): boolean {
  return hasSchedule && ratio >= ATTENTION_RATIO;
}

/** A row's last check-in as epoch ms; never checked reads as the epoch itself. */
function checkedAt(row: QuotaRow): number {
  return row.lastCheckedAt === null ? 0 : Date.parse(row.lastCheckedAt);
}

/** Order the rows, without mutating the input. */
export function sortRows(rows: readonly QuotaRow[], sort: QuotaSort): QuotaRow[] {
  const sign = sort.endsWith('_asc') ? 1 : -1;
  const byName = (left: QuotaRow, right: QuotaRow): number =>
    left.providerName.localeCompare(right.providerName);

  const sorted = [...rows];
  sorted.sort((left, right) => {
    // Every comparison falls back to the name, so the order is stable between
    // reads rather than depending on which provider the server emitted first.
    switch (sort) {
      case 'name_asc':
      case 'name_desc':
        return sign * byName(left, right);
      case 'usage_asc':
      case 'usage_desc':
        return sign * (rowUsage(left) - rowUsage(right)) || byName(left, right);
      case 'checked_asc':
      case 'checked_desc':
        // Never checked counts as the epoch, so it sorts as the oldest — which
        // floats it to the top of "longest since checked", exactly the list an
        // operator wants when deciding what to sweep next.
        return sign * (checkedAt(left) - checkedAt(right)) || byName(left, right);
    }
  });
  return sorted;
}

/** Narrow the rows to what the toolbar asked for. */
export function filterRows(rows: readonly QuotaRow[], filters: QuotaFilters): QuotaRow[] {
  const needle = filters.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.attention === 'attention' && !needsAttention(row)) return false;
    if (needle === '') return true;
    return (
      row.providerName.toLowerCase().includes(needle) ||
      row.providerId.toLowerCase().includes(needle)
    );
  });
}
