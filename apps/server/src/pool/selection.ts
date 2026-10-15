import type { LoadBalanceStrategy } from '@contracts';

/**
 * Which account a turn is sent as (FR-3.2).
 *
 * Two strategies, and they answer different questions. `sequential` is "use the
 * first one that is free", which keeps an operator's stated order — the account
 * they added first is the account that pays. `round_robin` is "spread the load",
 * and it is biased by in-flight count: among the accounts already free, the one
 * carrying the fewest turns goes next, so a slow provider does not pile every
 * request onto the same account while its neighbours sit idle.
 *
 * The rotation is a plain counter, not a list of who has had a turn. An account
 * that goes down and comes back rejoins the rotation at whatever position the
 * counter has reached, which is the behaviour an operator wants and is one line
 * of state instead of a table of last-used stamps.
 *
 * Pure, so the whole strategy is testable without a database: it takes the
 * candidates and a cursor, and returns the choice and the next cursor.
 */

export interface Candidate {
  readonly id: string;
  /** Turns currently in flight on this account, from the pool's own count. */
  readonly inFlight: number;
  readonly maxInFlight: number;
}

export interface Selection {
  readonly accountId: string;
  /** Where the next call resumes. Stored per provider by the pool. */
  readonly cursor: number;
}

/**
 * The account to use, or null when none of the candidates can take a turn.
 *
 * Candidates arrive in the order the operator's catalogue lists them, and that
 * order is what `sequential` honours and what `round_robin` rotates through.
 */
export function selectAccount(
  candidates: readonly Candidate[],
  strategy: LoadBalanceStrategy,
  cursor: number,
): Selection | null {
  const usable = candidates.filter((candidate) => candidate.inFlight < candidate.maxInFlight);
  if (usable.length === 0) return null;

  if (strategy === 'sequential') {
    const first = usable[0];
    if (first === undefined) return null;
    // The cursor does not advance: `sequential` has no rotation to resume.
    return { accountId: first.id, cursor };
  }

  // Least in flight first; ties broken by the rotation, so two idle accounts
  // alternate instead of the first one absorbing every turn.
  const fewest = Math.min(...usable.map((candidate) => candidate.inFlight));
  const least = usable.filter((candidate) => candidate.inFlight === fewest);
  const index = positiveModulo(cursor, least.length);
  const chosen = least[index];
  if (chosen === undefined) return null;
  return { accountId: chosen.id, cursor: cursor + 1 };
}

/** `%` that stays non-negative, so a cursor that ever went negative still indexes. */
function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}
