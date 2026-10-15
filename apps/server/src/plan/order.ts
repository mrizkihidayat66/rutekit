import { loadBalanceStrategySchema, type LoadBalanceStrategy } from '@contracts';
import type { RandomSource } from '@shared';

/**
 * Which candidate a combo tries first, and in what order the rest follow (FR-1.4).
 *
 * Both strategies produce a **whole ordered chain**, not a single pick, because
 * the dispatcher may walk it: when `fallbackOnError` is on, a failure on the
 * first entry moves to the second, so the order of the tail is as load-bearing as
 * the choice of the head. Returning one entry and leaving the dispatcher to find
 * the rest would put the ordering rule in two places.
 *
 * `sequential` is the operator's stated order, untouched. It is what the console
 * describes as "always starts at the first entry and works down the list", and it
 * is the only strategy whose meaning depends on the order the operator typed.
 *
 * `round_robin` picks the head **in proportion to weight** and leaves the rest in
 * their stated order. This is the same vocabulary the account pool uses for its
 * own `round_robin`, read the same way: a heavier entry is picked more often. The
 * tail is deliberately *not* re-weighted — once the head has failed, the operator
 * wants the next one they listed, not another roll of the dice.
 *
 * Pure, and takes its randomness as an argument, so a test can pin the choice
 * with a fixed source instead of asserting a distribution.
 */

export interface WeightedEntry<T> {
  readonly value: T;
  readonly weight: number;
}

/**
 * A strategy column, read fail-open.
 *
 * A combo's strategy is written only from the contract's enum, so an unreadable
 * one means the row was edited outside rutekit. Falling back to `sequential` — the
 * contract's own default — is the reading that keeps the chain in the order the
 * operator typed it, which is the conservative choice: a weighted pick from a
 * misread column would silently reorder their fallbacks.
 */
export function parseStrategy(raw: string): LoadBalanceStrategy {
  const parsed = loadBalanceStrategySchema.safeParse(raw);
  return parsed.success ? parsed.data : 'sequential';
}

/** The chain to try, best first. Never empty when the input was not. */
export function orderChain<T>(
  entries: readonly WeightedEntry<T>[],
  strategy: LoadBalanceStrategy,
  random: RandomSource,
): readonly T[] {
  const values = entries.map((entry) => entry.value);
  if (strategy === 'sequential' || entries.length < 2) return values;

  const head = pickWeighted(entries, random);
  if (head === null) return values;
  // The picked entry goes first and the rest keep their stated order, so a
  // fallback after the head fails is the operator's own second choice.
  return [head, ...values.filter((value) => value !== head)];
}

/**
 * One entry, chosen in proportion to weight. Null only when there is nothing to
 * choose from or every weight is non-positive, which leaves the caller free to
 * fall back to the stated order rather than to an arbitrary row.
 */
function pickWeighted<T>(
  entries: readonly WeightedEntry<T>[],
  random: RandomSource,
): T | null {
  const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  if (!(total > 0)) return null;

  let point = unitInterval(random) * total;
  for (const entry of entries) {
    point -= Math.max(0, entry.weight);
    if (point < 0) return entry.value;
  }
  // Floating point can leave `point` a hair above zero after the last entry, and
  // the last entry is the only defensible answer left.
  return entries[entries.length - 1]?.value ?? null;
}

/** Four random bytes as a number in `[0, 1)`. */
function unitInterval(random: RandomSource): number {
  const bytes = random(4);
  const value =
    ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
  return (value >>> 0) / 0x1_0000_0000;
}
