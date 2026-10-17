import type { AccountQuotaWrite } from '@server/persistence/provider-accounts.ts';

/**
 * What a provider's rate-limit headers say about one account (FR-3.6).
 *
 * There is no standard here, so this reads the two dialects that cover most of
 * the catalogue: the `x-ratelimit-*` family and Anthropic's `anthropic-ratelimit-*`
 * one. A provider that publishes neither is not a failure — the check-in still
 * proves the credential lives, which is the half of its job the state machine
 * needs. It just leaves the quota columns as they were.
 *
 * The window is derived rather than read, because no provider states its length:
 * they state when the window ends. `resetAt - now` is therefore the time left in
 * the current window, which is the window's length only at the moment it opens —
 * but it is the number an operator can act on, and it is what the console groups
 * its quota overview by. A provider that resets by sliding window rather than by
 * a fixed period will look like it has a short window, which is honest enough.
 */

const LIMIT_HEADERS = ['x-ratelimit-limit-requests', 'anthropic-ratelimit-requests-limit'] as const;
const REMAINING_HEADERS = [
  'x-ratelimit-remaining-requests',
  'anthropic-ratelimit-requests-remaining',
] as const;
const RESET_HEADERS = ['x-ratelimit-reset-requests', 'anthropic-ratelimit-requests-reset'] as const;

/** ISO-8601, or a duration like `1h2m3s` / `200ms`, or a plain count of seconds. */
const DURATION = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)ms)?(?:(\d+(?:\.\d+)?)s)?$/u;

function firstOf(headers: Headers, names: readonly string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null && value.trim() !== '') return value.trim();
  }
  return null;
}

function countOf(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** The instant a reset header names, or null when it names nothing readable. */
export function parseResetAt(raw: string | null, now: Date): string | null {
  if (raw === null) return null;

  if (/^\d{4}-\d{2}-\d{2}T/u.test(raw)) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  const match = DURATION.exec(raw);
  if (match !== null) {
    const [, hours, minutes, millis, seconds] = match;
    const total =
      Number(hours ?? 0) * 3600 +
      Number(minutes ?? 0) * 60 +
      Number(millis ?? 0) / 1000 +
      Number(seconds ?? 0);
    return total > 0 ? new Date(now.getTime() + total * 1000).toISOString() : null;
  }

  const bare = Number(raw);
  return Number.isFinite(bare) && bare >= 0
    ? new Date(now.getTime() + bare * 1000).toISOString()
    : null;
}

/**
 * The quota write a response's headers support, or null when they support none.
 *
 * Null rather than a row of nulls on purpose: `setQuota` overwrites every column,
 * so writing an all-null record would erase figures a previous check-in had
 * learned. A provider that stopped sending headers is a provider we know less
 * about, not one whose window disappeared.
 */
/** The value at a dot path, or undefined when the path does not resolve. */
function atPath(value: unknown, path: string | null): unknown {
  if (path === null) return value;
  let cursor: unknown = value;
  for (const key of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * The quota write a JSON answer supports, or null when it carries none.
 *
 * **A provider may state its limits in the body and nowhere else.** qoder is the
 * case: its usage endpoint answers `{userQuota: {total, remaining}, isQuotaExceeded}`
 * and its headers are silent, so a probe that read only headers learned nothing
 * about any qoder account. None was ever `exhausted`, and a free plan with no
 * credit stayed in rotation answering an empty stream to every turn.
 *
 * The mapping is declared by the manifest — paths, not code — so the next provider
 * with a body of its own needs a manifest edit and not a change here. A path that
 * does not resolve leaves its field null rather than guessing, and an answer with
 * nothing resolvable at all is null, which the caller treats as "learned nothing".
 */
export function readQuotaBody(
  body: unknown,
  declared: {
    readonly remaining: string | null;
    readonly limit: string | null;
    readonly exhausted: string | null;
    readonly resetAt: string | null;
  },
  now: Date,
): AccountQuotaWrite | null {
  const countAt = (path: string | null): number | null => {
    if (path === null) return null;
    const value = atPath(body, path);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };

  /**
   * `0 / 0` is a provider saying it does not report a balance, not an account
   * that has spent one. qoder answers exactly that on a plan it does not meter,
   * and writing it down would show "0 of 0" as though the account were empty.
   */
  const reported = countAt(declared.limit);
  const left = countAt(declared.remaining);
  const unreported = reported === 0 && left === 0;
  const limit = unreported ? null : reported;
  const remaining = unreported ? null : left;

  const rawReset = declared.resetAt === null ? undefined : atPath(body, declared.resetAt);
  const resetAt =
    typeof rawReset === 'number' && Number.isFinite(rawReset) && rawReset > 0
      ? new Date(rawReset).toISOString()
      : null;
  // A reset far in the future is a sentinel for "this does not reset", and qoder
  // sends year 9999 for it. Rendering that as a date is worse than rendering
  // nothing, so it is dropped rather than clamped.
  const horizon = now.getTime() + 10 * 365 * 24 * 3600 * 1000;
  const saneReset = resetAt !== null && Date.parse(resetAt) <= horizon ? resetAt : null;

  /**
   * The provider's own verdict, recorded as a balance of zero.
   *
   * **This is the one thing that distinguishes "spent" from "unreported".** qoder
   * reports `0 / 0` on a free plan and leaves `remaining` alone; it is
   * `isQuotaExceeded` that says the allowance is gone. Writing zero only when the
   * provider says so keeps a `0 / 0` answer null, which is what stops the console
   * showing an empty balance for an account that has simply not been metered.
   *
   * What a zero balance does *not* mean is that the account cannot serve: `lite`
   * costs nothing and answers anyway. It means a **metered** model cannot.
   */
  const flagged = declared.exhausted === null ? undefined : atPath(body, declared.exhausted);
  const creditBalance = flagged === true ? 0 : null;

  if (limit === null && remaining === null && saneReset === null && creditBalance === null) {
    return null;
  }

  const windowSeconds =
    saneReset === null
      ? null
      : Math.max(0, Math.round((Date.parse(saneReset) - now.getTime()) / 1000));

  return {
    windowSeconds,
    limit,
    remaining,
    resetAt: saneReset,
    creditBalance,
    creditCurrency: null,
  };
}

export function readQuota(headers: Headers, now: Date): AccountQuotaWrite | null {
  const limit = countOf(firstOf(headers, LIMIT_HEADERS));
  const remaining = countOf(firstOf(headers, REMAINING_HEADERS));
  const resetAt = parseResetAt(firstOf(headers, RESET_HEADERS), now);

  if (limit === null && remaining === null && resetAt === null) return null;

  const windowSeconds =
    resetAt === null ? null : Math.max(0, Math.round((Date.parse(resetAt) - now.getTime()) / 1000));

  return {
    windowSeconds,
    limit,
    remaining,
    resetAt,
    // Neither dialect reports a credit balance; that is a provider-specific
    // figure with no header convention behind it, so it stays null.
    creditBalance: null,
    creditCurrency: null,
  };
}
