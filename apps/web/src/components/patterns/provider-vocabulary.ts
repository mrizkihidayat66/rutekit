import type { AccountState, ProviderCategory, ProviderStatus, WireFamily } from '@contracts';

import type { Tone } from './tone.ts';

/**
 * The Providers section's words.
 *
 * Four pages speak about the same two entities — a provider and an account — so
 * the labels, the tones and the filter lists live here once rather than being
 * re-spelled per page and drifting apart. Nothing here renders; it is pure data
 * plus two lookups, which keeps it out of the fast-refresh boundary.
 */

/* ---- Provider ---- */

export const PROVIDER_STATUS_LABELS: Record<ProviderStatus, string> = {
  ready: 'Ready',
  needs_auth: 'Needs auth',
  error: 'Error',
  disabled: 'Disabled',
};

export const PROVIDER_STATUS_TONES: Record<ProviderStatus, Tone> = {
  ready: 'success',
  needs_auth: 'warning',
  error: 'danger',
  disabled: 'neutral',
};

/** How a status reads in a sentence, for a tooltip or an empty-state hint. */
export const PROVIDER_STATUS_HINTS: Record<ProviderStatus, string> = {
  ready: 'Reachable and holding at least one usable credential.',
  needs_auth: 'Configured, but no working credential is attached yet.',
  error: 'The last call to this provider failed.',
  disabled: 'Switched off by an operator; routing skips it entirely.',
};

export const PROVIDER_STATUSES: readonly ProviderStatus[] = [
  'ready',
  'needs_auth',
  'error',
  'disabled',
];

export const PROVIDER_CATEGORY_LABELS: Record<ProviderCategory, string> = {
  oauth: 'OAuth',
  'api-key': 'API key',
  media: 'Media',
  search: 'Search',
  local: 'Local',
  byok: 'Custom (BYOK)',
  aggregator: 'Aggregator',
  free: 'Free',
};

/** One line per category, shown when a filter or a card needs to explain itself. */
export const PROVIDER_CATEGORY_HINTS: Record<ProviderCategory, string> = {
  oauth: 'Signed in through the provider’s own browser flow.',
  'api-key': 'Authenticated with a key the operator pastes in.',
  media: 'Serves images, audio or video rather than chat completions.',
  search: 'Answers retrieval queries instead of completions.',
  local: 'Runs on this machine; no credential and no quota.',
  byok: 'An endpoint the operator supplies, configured rather than discovered.',
  aggregator: 'A gateway that fronts many upstream providers at once.',
  free: 'Public and credential-free — anyone can call it, and there is no bill.',
};

export const PROVIDER_CATEGORIES: readonly ProviderCategory[] = [
  'oauth',
  'api-key',
  'media',
  'search',
  'local',
  'byok',
  'aggregator',
  'free',
];

export const WIRE_FAMILY_LABELS: Record<WireFamily, string> = {
  openai: 'OpenAI-compatible',
  anthropic: 'Anthropic Messages',
  google: 'Google Generative AI',
  custom: 'Custom',
};

export const WIRE_FAMILIES: readonly WireFamily[] = ['openai', 'anthropic', 'google', 'custom'];

/* ---- Account ---- */

export const ACCOUNT_STATE_LABELS: Record<AccountState, string> = {
  active: 'Active',
  banned: 'Banned',
  disabled: 'Disabled',
  exhausted: 'Exhausted',
  error: 'Error',
  pending: 'Pending',
  rate_limited: 'Rate limited',
};

/**
 * One colour per state, straight from the `--color-state-*` tokens.
 *
 * The seven states are the pool's own vocabulary, so they get the pool's own
 * palette rather than being squeezed into success/warning/danger — `exhausted`
 * and `rate_limited` are both "needs attention" but they are not the same thing,
 * and an operator scanning the table can tell them apart at a glance.
 */
export const ACCOUNT_STATE_CHIP: Record<AccountState, string> = {
  active: 'bg-state-active/12 text-state-active-text border-state-active/25',
  banned: 'bg-state-banned/12 text-state-banned-text border-state-banned/25',
  disabled: 'bg-state-disabled/12 text-state-disabled-text border-state-disabled/25',
  exhausted: 'bg-state-exhausted/12 text-state-exhausted-text border-state-exhausted/25',
  error: 'bg-state-error/12 text-state-error-text border-state-error/25',
  pending: 'bg-state-pending/12 text-state-pending-text border-state-pending/25',
  rate_limited:
    'bg-state-rate-limited/14 text-state-rate-limited-text border-state-rate-limited/30',
};

/** A solid dot in the same colour, for a legend or a compact row marker. */
export const ACCOUNT_STATE_DOT: Record<AccountState, string> = {
  active: 'bg-state-active',
  banned: 'bg-state-banned',
  disabled: 'bg-state-disabled',
  exhausted: 'bg-state-exhausted',
  error: 'bg-state-error',
  pending: 'bg-state-pending',
  rate_limited: 'bg-state-rate-limited',
};

/** What each state means for the pool, in operator language. */
export const ACCOUNT_STATE_HINTS: Record<AccountState, string> = {
  active: 'In the rotation; routing may pick it.',
  banned: 'The provider refused this credential outright.',
  disabled: 'Taken out of rotation by an operator.',
  exhausted: 'Its quota is spent and it is waiting for a reset.',
  error: 'The last call failed; it backs off before retrying.',
  pending: 'Added but not yet used, so it is not in the rotation.',
  rate_limited: 'Throttled by the provider; it cools down and returns on its own.',
};

export const ACCOUNT_STATES: readonly AccountState[] = [
  'active',
  'pending',
  'rate_limited',
  'exhausted',
  'error',
  'banned',
  'disabled',
];

/* ---- Filter option lists ---- */

export interface VocabularyOption<TValue extends string> {
  readonly value: TValue;
  readonly label: string;
}

/** The catalog's category filter, with "all" in front. */
export const PROVIDER_CATEGORY_OPTIONS: readonly VocabularyOption<'all' | ProviderCategory>[] = [
  { value: 'all', label: 'All categories' },
  ...PROVIDER_CATEGORIES.map((category) => ({
    value: category,
    label: PROVIDER_CATEGORY_LABELS[category],
  })),
];

export const PROVIDER_STATUS_OPTIONS: readonly VocabularyOption<'all' | ProviderStatus>[] = [
  { value: 'all', label: 'Any status' },
  ...PROVIDER_STATUSES.map((status) => ({ value: status, label: PROVIDER_STATUS_LABELS[status] })),
];

export const ACCOUNT_STATE_OPTIONS: readonly VocabularyOption<'all' | AccountState>[] = [
  { value: 'all', label: 'Any state' },
  ...ACCOUNT_STATES.map((state) => ({ value: state, label: ACCOUNT_STATE_LABELS[state] })),
];

export const WIRE_FAMILY_OPTIONS: readonly VocabularyOption<WireFamily>[] = WIRE_FAMILIES.map(
  (family) => ({
    value: family,
    label: WIRE_FAMILY_LABELS[family],
  }),
);

/* ---- Narrowing ---- */

export function isProviderCategory(value: string): value is ProviderCategory {
  return PROVIDER_CATEGORIES.includes(value as ProviderCategory);
}

export function isProviderStatus(value: string): value is ProviderStatus {
  return PROVIDER_STATUSES.includes(value as ProviderStatus);
}

export function isAccountState(value: string): value is AccountState {
  return ACCOUNT_STATES.includes(value as AccountState);
}

export function isWireFamily(value: string): value is WireFamily {
  return WIRE_FAMILIES.includes(value as WireFamily);
}
