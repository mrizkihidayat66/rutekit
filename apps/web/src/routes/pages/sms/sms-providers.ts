import type { SmsProvider, SmsProviderKind, SmsProviderStatus, SortDirection } from '@contracts';

import type { Tone } from '@web/components/patterns/tone.ts';

/**
 * The SMS Providers page's own vocabulary.
 *
 * Kept out of the components so those files stay components-only for the
 * fast-refresh boundary, and so the table, the toolbar, the dialogs and the
 * summary tiles agree on the handful of things they share: what each status is
 * called, which kind a key is, and what the pool can be ordered by.
 *
 * A filter has to be able to say "do not narrow", and the endpoint's `null` is
 * not something a select can hold — so each one carries its own "any" value,
 * exactly the shape the proxy pool uses.
 */

/** Every activation service rutekit can drive. One for now, and the form offers it. */
export const SMS_PROVIDER_KINDS: readonly SmsProviderKind[] = ['5sim'];

export const SMS_PROVIDER_KIND_LABELS: Record<SmsProviderKind, string> = {
  '5sim': '5sim',
};

/**
 * What each kind is, for the form's hint under the picker.
 *
 * The name alone is not enough: an operator who has keys for two services needs
 * to know which one the label on their key belongs to, and the answer is the
 * address it is spent at.
 */
export const SMS_PROVIDER_KIND_HINTS: Record<SmsProviderKind, string> = {
  '5sim': 'Numbers are rented from 5sim.net and paid for out of the key’s balance.',
};

/** Every state a key may be in, worst-last so the list reads as a scale. */
export const SMS_PROVIDER_STATUSES: readonly SmsProviderStatus[] = [
  'active',
  'untested',
  'disabled',
  'error',
];

export const SMS_PROVIDER_STATUS_LABELS: Record<SmsProviderStatus, string> = {
  active: 'Active',
  untested: 'Untested',
  disabled: 'Disabled',
  error: 'Error',
};

/**
 * What each state means for the pool.
 *
 * The colour is the same one the summary tile above the table uses, so a row and
 * the tally it contributes to can never be read as two different things.
 */
export const SMS_PROVIDER_STATUS_TONES: Record<SmsProviderStatus, Tone> = {
  active: 'success',
  untested: 'neutral',
  disabled: 'info',
  error: 'danger',
};

export const SMS_PROVIDER_STATUS_HINTS: Record<SmsProviderStatus, string> = {
  active: 'The key answered on its last check and has balance to spend.',
  untested: 'Never checked since it was added, so nothing is known about its balance.',
  disabled: 'Held back by an operator. Registration jobs will not rent through it.',
  error: 'The service refused the key, or the key is out of balance.',
};

/** The kind filter: any service, or one of them. */
export type KindFilter = 'all' | SmsProviderKind;

export const KIND_FILTERS: readonly KindFilter[] = ['all', ...SMS_PROVIDER_KINDS];

export function isKindFilter(value: string): value is KindFilter {
  return value === 'all' || SMS_PROVIDER_KINDS.includes(value as SmsProviderKind);
}

/** What the endpoint wants: a real kind, or null to leave the list whole. */
export function kindParam(filter: KindFilter): SmsProviderKind | null {
  return filter === 'all' ? null : filter;
}

/** The status filter: any state, or one of the four. */
export type StatusFilter = 'all' | SmsProviderStatus;

export const STATUS_FILTERS: readonly StatusFilter[] = ['all', ...SMS_PROVIDER_STATUSES];

export function isStatusFilter(value: string): value is StatusFilter {
  return value === 'all' || SMS_PROVIDER_STATUSES.includes(value as SmsProviderStatus);
}

export function statusParam(filter: StatusFilter): SmsProviderStatus | null {
  return filter === 'all' ? null : filter;
}

/**
 * What the pool can be ordered by.
 *
 * Balance is first among the fields that are not the default, because the
 * question this page is opened with is "which key still has money" — a
 * registration job that fails at the number-rental step has usually run one dry.
 * Status answers "is anything refusing", and the tallies answer "which key
 * actually works".
 */
export const SMS_PROVIDER_SORT_KEYS = [
  'createdAt',
  'balance',
  'status',
  'successCount',
  'failCount',
  'lastCheckedAt',
  'label',
] as const;
export type SmsProviderSortKey = (typeof SMS_PROVIDER_SORT_KEYS)[number];

export const DEFAULT_SMS_PROVIDER_SORT: SmsProviderSortKey = 'createdAt';

export function isSmsProviderSortKey(value: string): value is SmsProviderSortKey {
  return SMS_PROVIDER_SORT_KEYS.includes(value as SmsProviderSortKey);
}

export const SMS_PROVIDER_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];
export const DEFAULT_SMS_PROVIDER_DIRECTION: SortDirection = 'desc';

export function isSmsProviderDirection(value: string): value is SortDirection {
  return value === 'asc' || value === 'desc';
}

/** A key is one row and a pool is small, so a page is generous. */
export const SMS_PROVIDER_PAGE_SIZE = 40;

/** Whether anything is narrowing the list, so "Clear filters" can appear. */
export function smsProviderNarrowed(
  search: string,
  kind: KindFilter,
  status: StatusFilter,
): boolean {
  return search.trim() !== '' || kind !== 'all' || status !== 'all';
}

/** How many numbers a key has been asked to rent, delivered or not. */
export function smsProviderAttempts(sms: SmsProvider): number {
  return sms.successCount + sms.failCount;
}

/**
 * How well a key delivers, as a ratio — `0` when it has never been asked.
 *
 * Deliberately not a percentage: the caller decides whether the number is worth
 * showing at all, and a key that has never been used should not read as "0%
 * reliable" when the truth is "not yet tried".
 */
export function smsProviderSuccessRatio(sms: SmsProvider): number {
  const attempts = smsProviderAttempts(sms);
  return attempts === 0 ? 0 : sms.successCount / attempts;
}
