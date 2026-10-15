import type { ApiKey, ApiKeyInput, ApiKeyState, SortDirection } from '@contracts';
import { deriveApiKeyState } from '@contracts';

import type { Tone } from '@web/components/patterns/tone.ts';
import { formatCount, formatDateTime, formatRelative, formatTokens } from '@web/lib/format.ts';

/**
 * The API Keys page's vocabulary.
 *
 * A key is the console's unit of delegated access, and almost everything an
 * operator wants to say about one is a ceiling: which models it may reach, how
 * fast it may go, how much it may spend, and when it stops working. The page is
 * therefore built around stating those ceilings plainly rather than around the
 * secret, which is the one part of a key that is only ever seen once.
 *
 * Two of those ceilings are the reason this page exists at all. Expiry (FR-6.3)
 * and a tokens-per-second cap (FR-6.4) are capabilities none of the reference
 * projects have, so they are given first-class fields rather than being folded
 * into a free-text settings blob — a limit nobody can see is a limit nobody sets.
 *
 * Nothing here renders, so any component on the page may import it without
 * breaking fast refresh.
 */

/* ---- Lifecycle state ---- */

/**
 * The states a key can be in. Derived rather than stored, because every one of
 * them is a consequence of a field the key already has: a key is revoked
 * because it was revoked, expired because its date passed, exhausted because a
 * budget was reached. Storing the state as well would give two sources of truth
 * that disagree the moment a clock moves.
 */
export const KEY_STATES = ['active', 'expired', 'revoked', 'exhausted'] as const;

export const KEY_STATE_LABELS: Record<ApiKeyState, string> = {
  active: 'Active',
  expired: 'Expired',
  revoked: 'Revoked',
  exhausted: 'Exhausted',
};

export const KEY_STATE_TONES: Record<ApiKeyState, Tone> = {
  active: 'success',
  expired: 'warning',
  revoked: 'danger',
  exhausted: 'warning',
};

/** One line on why a key is in this state, for the badge's tooltip. */
export const KEY_STATE_HINTS: Record<ApiKeyState, string> = {
  active: 'Working, and within every limit it was given.',
  expired: 'Past its expiry date. Requests using it are refused.',
  revoked: 'Switched off by hand. This cannot be undone.',
  exhausted: 'Has used its whole request or token budget.',
};

/* ---- Filtering ---- */

/**
 * The state filter, which includes "any". This one is answered by the endpoint
 * rather than in the browser: the state is derived from three fields, so
 * narrowing it in the browser would mean paging through everything and filtering
 * what happened to be on the page.
 */
export const KEY_FILTERS = ['all', ...KEY_STATES] as const;
export type KeyFilter = (typeof KEY_FILTERS)[number];

export const KEY_FILTER_LABELS: Record<KeyFilter, string> = {
  all: 'Any state',
  ...KEY_STATE_LABELS,
};

export const KEY_FILTER_OPTIONS: readonly { readonly value: KeyFilter; readonly label: string }[] =
  KEY_FILTERS.map((value) => ({ value, label: KEY_FILTER_LABELS[value] }));

export function isKeyFilter(value: string): value is KeyFilter {
  return KEY_FILTERS.includes(value as KeyFilter);
}

/** The `state` query parameter, where "all" has to become "no filter". */
export function stateParam(filter: KeyFilter): ApiKeyState | null {
  return filter === 'all' ? null : filter;
}

export function keyNarrowed(search: string, filter: KeyFilter): boolean {
  return search !== '' || filter !== 'all';
}

/* ---- Sorting ---- */

export const KEY_SORT_KEYS = ['name', 'createdAt', 'expiresAt', 'lastUsedAt'] as const;
export type KeySortKey = (typeof KEY_SORT_KEYS)[number];

export const KEY_SORT_LABELS: Record<KeySortKey, string> = {
  name: 'Name',
  createdAt: 'Created',
  expiresAt: 'Expires',
  lastUsedAt: 'Last used',
};

/**
 * Newest first by default. The list is a record of what has been issued, so the
 * thing most often wanted is the key that was just made.
 */
export const DEFAULT_KEY_SORT: KeySortKey = 'createdAt';
export const DEFAULT_KEY_DIRECTION: SortDirection = 'desc';
export const KEY_DIRECTIONS: readonly SortDirection[] = ['asc', 'desc'];

export function isKeySortKey(value: string): value is KeySortKey {
  return KEY_SORT_KEYS.includes(value as KeySortKey);
}

export function isKeyDirection(value: string): value is SortDirection {
  return KEY_DIRECTIONS.includes(value as SortDirection);
}

/**
 * How many keys a page holds. Keys are issued by hand and revoked by hand, so a
 * console with hundreds of them is unusual; one page is normally the whole list
 * and the cap only bounds the pathological case.
 */
export const KEY_PAGE_SIZE = 50;

/* ---- Drafts ---- */

/**
 * The expiry control's choices.
 *
 * Presets are offered because "in 90 days" is what an operator actually means
 * when they rotate a key, and making them compute a date invites an off-by-one.
 * "Pick a date" stays available because a key that has to lapse with a contract
 * needs a real date, and an existing key's date has to be editable as itself
 * rather than re-derived from today.
 */
export const EXPIRY_CHOICES = ['never', '7d', '30d', '90d', '1y', 'custom'] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];

export const EXPIRY_LABELS: Record<ExpiryChoice, string> = {
  never: 'Never expires',
  '7d': 'In 7 days',
  '30d': 'In 30 days',
  '90d': 'In 90 days',
  '1y': 'In 1 year',
  custom: 'Pick a date',
};

export const EXPIRY_OPTIONS: readonly { readonly value: ExpiryChoice; readonly label: string }[] =
  EXPIRY_CHOICES.map((value) => ({ value, label: EXPIRY_LABELS[value] }));

export function isExpiryChoice(value: string): value is ExpiryChoice {
  return EXPIRY_CHOICES.includes(value as ExpiryChoice);
}

const EXPIRY_DAYS: Record<'7d' | '30d' | '90d' | '1y', number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
};

const DAY_MS = 86_400_000;

/**
 * One key being created or edited.
 *
 * Every ceiling is a string because this is form state: a number field the
 * operator is halfway through clearing holds `''`, which is how "unlimited" is
 * spelled here, and coercing on each keystroke would fight the person typing.
 * The conversions happen once, on submit.
 *
 * The two model lists are arrays rather than text, because they are edited as
 * chips — a comma-separated string would have to be re-parsed on every render
 * and would lose the operator's place the moment one contained a comma.
 *
 * Each chip list carries its own in-progress text alongside the committed names.
 * Without it, a name typed and not yet confirmed would be dropped the moment the
 * operator reached for the submit button, because the click and the state update
 * that would have committed it happen in the same tick.
 */
export interface KeyDraft {
  readonly name: string;
  readonly modelsAllowed: readonly string[];
  readonly modelsAllowedText: string;
  readonly modelsDenied: readonly string[];
  readonly modelsDeniedText: string;
  readonly expiry: ExpiryChoice;
  /** `datetime-local` text. Only read when `expiry` is `custom`. */
  readonly expiresAt: string;
  readonly tpsLimit: string;
  readonly rateLimitPerMinute: string;
  readonly budgetRequests: string;
  readonly budgetTokens: string;
  readonly clientRouterDenylist: readonly string[];
  readonly clientRouterText: string;
}

export const EMPTY_KEY_DRAFT: KeyDraft = {
  name: '',
  modelsAllowed: [],
  modelsAllowedText: '',
  modelsDenied: [],
  modelsDeniedText: '',
  expiry: 'never',
  expiresAt: '',
  tpsLimit: '',
  rateLimitPerMinute: '',
  budgetRequests: '',
  budgetTokens: '',
  clientRouterDenylist: [],
  clientRouterText: '',
};

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in local time, not an ISO instant. */
function toLocalInput(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function draftFromKey(key: ApiKey): KeyDraft {
  return {
    name: key.name,
    modelsAllowed: [...key.modelsAllowed],
    modelsAllowedText: '',
    modelsDenied: [...key.modelsDenied],
    modelsDeniedText: '',
    // A saved date is always shown as itself: a preset would silently re-derive
    // it from today, which is not what "edit this key" should ever do.
    expiry: key.expiresAt === null ? 'never' : 'custom',
    expiresAt: key.expiresAt === null ? '' : toLocalInput(key.expiresAt),
    tpsLimit: key.tpsLimit === null ? '' : String(key.tpsLimit),
    rateLimitPerMinute: key.rateLimitPerMinute === null ? '' : String(key.rateLimitPerMinute),
    budgetRequests: key.budgetRequests === null ? '' : String(key.budgetRequests),
    budgetTokens: key.budgetTokens === null ? '' : String(key.budgetTokens),
    clientRouterDenylist: [...key.clientRouterDenylist],
    clientRouterText: '',
  };
}

/**
 * The three chip lists a draft holds, folded with whatever is still being typed
 * into each. Every read of a draft's names goes through here, so an unconfirmed
 * name cannot be silently dropped on submit.
 */
export function draftChips(draft: KeyDraft): {
  readonly modelsAllowed: readonly string[];
  readonly modelsDenied: readonly string[];
  readonly clientRouterDenylist: readonly string[];
} {
  return {
    modelsAllowed: addTokens(draft.modelsAllowed, draft.modelsAllowedText),
    modelsDenied: addTokens(draft.modelsDenied, draft.modelsDeniedText),
    clientRouterDenylist: addTokens(draft.clientRouterDenylist, draft.clientRouterText),
  };
}

/**
 * A ceiling, or `null` for unlimited, or `undefined` when the text is neither.
 * Empty means unlimited — that is the only reading of a blank limit field.
 */
export function parseCeiling(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/** Whether a ceiling field holds something that is neither blank nor a number. */
export function ceilingBad(value: string): boolean {
  return parseCeiling(value) === undefined;
}

/**
 * The instant a draft's expiry resolves to: an ISO string, `null` for never, or
 * `undefined` when a custom date is missing or unparseable.
 */
export function resolveExpiry(draft: KeyDraft, now: Date): string | null | undefined {
  if (draft.expiry === 'never') return null;
  if (draft.expiry === 'custom') {
    if (draft.expiresAt.trim() === '') return undefined;
    const parsed = Date.parse(draft.expiresAt);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }
  return new Date(now.getTime() + EXPIRY_DAYS[draft.expiry] * DAY_MS).toISOString();
}

/** The date a preset resolves to, so the form can show it rather than imply it. */
export function expiryPreview(draft: KeyDraft, now: Date): string | null {
  const resolved = resolveExpiry(draft, now);
  if (resolved === null || resolved === undefined) return null;
  return formatDateTime(resolved);
}

const CEILING_FIELDS = [
  { key: 'tpsLimit', label: 'TPS limit' },
  { key: 'rateLimitPerMinute', label: 'Rate limit' },
  { key: 'budgetRequests', label: 'Request budget' },
  { key: 'budgetTokens', label: 'Token budget' },
] as const;

/**
 * The one problem with no field of its own: a model on both lists.
 *
 * Reported apart from the rest because every other problem is shown beside the
 * input that caused it, and those fields already mark themselves invalid. Saying
 * the same sentence again in a banner below the form would read as two separate
 * faults, so the banner carries only what no field can point at.
 */
export function scopeClash(draft: KeyDraft): string | undefined {
  const chips = draftChips(draft);
  const allowed = new Set(chips.modelsAllowed);
  const clash = chips.modelsDenied.find((model) => allowed.has(model));
  if (clash === undefined) return undefined;
  return `"${clash}" is on both the allowlist and the denylist. A model has to be one or the other.`;
}

/**
 * What is wrong with a draft, as one sentence, or `undefined` when it is
 * sendable. Reported in field order so the sentence points at the first thing
 * the operator would reach.
 */
export function keyDraftProblem(draft: KeyDraft, now: Date): string | undefined {
  if (draft.name.trim() === '') return 'Give the key a name.';
  if (resolveExpiry(draft, now) === undefined) return 'Pick a valid expiry date.';
  for (const field of CEILING_FIELDS) {
    if (parseCeiling(draft[field.key]) === undefined) {
      return `${field.label} must be a whole number greater than zero, or empty for unlimited.`;
    }
  }
  return scopeClash(draft);
}

/**
 * The body a draft posts, or `undefined` when it is not sendable yet.
 *
 * `original` is the key being edited, when there is one. It exists for one
 * reason: the date control works to the minute, so a saved expiry edited and
 * left alone would otherwise come back with its seconds shaved off — a silent
 * change to a field nobody touched.
 */
export function inputFromDraft(
  draft: KeyDraft,
  now: Date,
  original?: ApiKey | null,
): ApiKeyInput | undefined {
  if (keyDraftProblem(draft, now) !== undefined) return undefined;
  let expiresAt = resolveExpiry(draft, now);
  if (expiresAt === undefined) return undefined;
  if (
    original !== null &&
    original !== undefined &&
    original.expiresAt !== null &&
    draft.expiry === 'custom' &&
    draft.expiresAt === toLocalInput(original.expiresAt)
  ) {
    expiresAt = original.expiresAt;
  }
  const tpsLimit = parseCeiling(draft.tpsLimit);
  const rateLimitPerMinute = parseCeiling(draft.rateLimitPerMinute);
  const budgetRequests = parseCeiling(draft.budgetRequests);
  const budgetTokens = parseCeiling(draft.budgetTokens);
  if (
    tpsLimit === undefined ||
    rateLimitPerMinute === undefined ||
    budgetRequests === undefined ||
    budgetTokens === undefined
  ) {
    return undefined;
  }
  const chips = draftChips(draft);
  return {
    name: draft.name.trim(),
    modelsAllowed: [...chips.modelsAllowed],
    modelsDenied: [...chips.modelsDenied],
    budgetRequests,
    budgetTokens,
    tpsLimit,
    rateLimitPerMinute,
    expiresAt,
    clientRouterDenylist: [...chips.clientRouterDenylist],
  };
}

/* ---- Chip lists ---- */

/**
 * Add whatever was typed to a chip list, splitting on commas and whitespace so a
 * pasted `gpt-4o, gpt-4.1` arrives as two chips. Duplicates are dropped rather
 * than reordered: the list is a set of names, and showing the same name twice
 * would make the operator think the key had two entries.
 */
export function addTokens(list: readonly string[], raw: string): readonly string[] {
  const additions = raw
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token !== '');
  if (additions.length === 0) return list;
  const seen = new Set(list);
  const next = [...list];
  for (const token of additions) {
    if (!seen.has(token)) {
      seen.add(token);
      next.push(token);
    }
  }
  return next;
}

export function removeToken(list: readonly string[], token: string): readonly string[] {
  return list.filter((entry) => entry !== token);
}

/* ---- Reading a key ---- */

/** The state a key is in right now. */
export function keyState(key: ApiKey, now?: Date): ApiKeyState {
  return now === undefined ? deriveApiKeyState(key) : deriveApiKeyState(key, now);
}

/**
 * What a key may reach, in a few words.
 *
 * An empty allowlist means every model, which is a stronger statement than a
 * long allowlist and is written as one — "All models" rather than "0 allowed".
 */
export function scopeSummary(key: ApiKey): string {
  const parts: string[] = [];
  if (key.modelsAllowed.length === 0) parts.push('All models');
  else parts.push(`${formatCount(key.modelsAllowed.length)} allowed`);
  if (key.modelsDenied.length > 0) parts.push(`${formatCount(key.modelsDenied.length)} denied`);
  return parts.join(' · ');
}

/** The rate ceilings, or that there are none. */
export function limitSummary(key: ApiKey): string {
  const parts: string[] = [];
  if (key.tpsLimit !== null) parts.push(`${formatCount(key.tpsLimit)} TPS`);
  if (key.rateLimitPerMinute !== null) parts.push(`${formatCount(key.rateLimitPerMinute)} rpm`);
  return parts.length === 0 ? 'No rate limit' : parts.join(' · ');
}

/** How spent a budget is, as a `0..1` ratio, or `null` when unlimited. */
export function budgetRatio(key: ApiKey): number | null {
  const ratios: number[] = [];
  if (key.budgetRequests !== null && key.budgetRequests > 0) {
    ratios.push(key.usage.requests / key.budgetRequests);
  }
  if (key.budgetTokens !== null && key.budgetTokens > 0) {
    const used = key.usage.inputTokens + key.usage.outputTokens;
    ratios.push(used / key.budgetTokens);
  }
  if (ratios.length === 0) return null;
  return Math.max(...ratios);
}

/** What a budget has left, as the figure the meter is a picture of. */
export function budgetSummary(key: ApiKey): string {
  const parts: string[] = [];
  if (key.budgetRequests !== null) {
    parts.push(`${formatCount(key.usage.requests)}/${formatCount(key.budgetRequests)} req`);
  }
  if (key.budgetTokens !== null) {
    const used = key.usage.inputTokens + key.usage.outputTokens;
    parts.push(`${formatTokens(used)}/${formatTokens(key.budgetTokens)} tok`);
  }
  return parts.length === 0 ? 'No budget' : parts.join(' · ');
}

/** When a key stops working, or that it does not. */
export function expirySummary(key: ApiKey, now?: number): string {
  if (key.expiresAt === null) return 'Never';
  return now === undefined ? formatRelative(key.expiresAt) : formatRelative(key.expiresAt, now);
}

export function lastUsedSummary(key: ApiKey, now?: number): string {
  if (key.lastUsedAt === null) return 'Never used';
  return now === undefined ? formatRelative(key.lastUsedAt) : formatRelative(key.lastUsedAt, now);
}

/** Whether a live key's expiry is close enough to be worth flagging. */
export function expiringSoon(key: ApiKey, now: number = Date.now()): boolean {
  if (key.expiresAt === null) return false;
  const at = Date.parse(key.expiresAt);
  if (Number.isNaN(at)) return false;
  return at > now && at - now <= 14 * DAY_MS;
}
