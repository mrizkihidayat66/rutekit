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
