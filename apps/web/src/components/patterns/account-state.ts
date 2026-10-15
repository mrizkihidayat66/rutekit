import type { Account } from '@contracts';

/**
 * Account-state derivations shared by the two pages that show the pool.
 *
 * Provider Detail narrows the pool to one provider; the Accounts page shows all
 * of it. Both must agree about what "cooling" means — an account whose window
 * has already elapsed is not parked, and a page that counted it as parked would
 * contradict the countdown printed in its own table. The derivation lives here
 * once rather than being re-spelled per page and drifting apart.
 *
 * Nothing here renders, which keeps it importable from any of those pages'
 * components without breaking fast refresh.
 */

/**
 * Seconds left on an account's cooldown, or null when it is not cooling.
 *
 * Cooldown is derived, never stored: the row carries a `cooldownUntil`
 * timestamp, and whether it is *currently* cooling is a question about the
 * clock rather than about the row.
 */
export function cooldownSeconds(account: Account, nowMs: number): number | null {
  if (account.cooldownUntil === null) return null;
  const until = Date.parse(account.cooldownUntil);
  if (Number.isNaN(until)) return null;
  const seconds = Math.ceil((until - nowMs) / 1000);
  return seconds > 0 ? seconds : null;
}
