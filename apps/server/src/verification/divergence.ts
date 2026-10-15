/**
 * Distributions, and the divergence between two of them (C12, FR-10.2).
 *
 * The core measurement is Jensen–Shannon divergence over a first-token
 * distribution: draw N answers from an endpoint, count which token came first
 * each time, and compare that shape against a reference measured from a model the
 * operator trusts. JSD rather than KL because it is symmetric and bounded — KL
 * is infinite the moment the reference has mass somewhere the sample does not,
 * which for a distribution built from a few dozen draws is the common case rather
 * than the edge case.
 *
 * **JSD is reported in bits, and its ceiling is 1.** Two distributions over
 * disjoint supports are 1 bit apart, not infinitely far, which is what makes it
 * usable as a likelihood: `exp(-jsd/tau)` is a number in (0, 1] and needs no
 * special case for a token that never appeared.
 *
 * **Smoothing is not optional.** An empirical distribution from N draws has no
 * mass on the tokens that did not come up, so every comparison would find
 * disjoint supports somewhere. A small floor is added to every token in either
 * distribution before normalising, which is the standard reading: "this token is
 * possible and I did not happen to see it".
 */

/** Token → share. Shares sum to about 1 after normalising. */
export type Distribution = Readonly<Record<string, number>>;

/**
 * The floor added to every token before normalising.
 *
 * Small enough that a token seen once in forty draws still dominates it, large
 * enough that a token seen in the reference and never here does not make the
 * supports disjoint.
 */
const SMOOTHING = 1e-4;

/** Counts as shares, with the smoothing floor applied and the result normalised. */
export function toDistribution(counts: Readonly<Record<string, number>>): Distribution {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return {};

  const smoothed: Record<string, number> = {};
  for (const [token, count] of entries) {
    smoothed[token] = count / total + SMOOTHING;
  }
  const sum = Object.values(smoothed).reduce((totalShare, share) => totalShare + share, 0);
  for (const token of Object.keys(smoothed)) {
    smoothed[token] = (smoothed[token] ?? 0) / sum;
  }
  return smoothed;
}

/**
 * Jensen–Shannon divergence in bits, in `[0, 1]`.
 *
 * `null` when either side is empty: a divergence against nothing is not a large
 * divergence, it is a missing measurement, and reporting it as 1 would let a
 * probe that never ran count as strong evidence against the claim.
 */
export function jensenShannon(a: Distribution, b: Distribution): number | null {
  const tokens = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (tokens.size === 0) return null;
  if (Object.keys(a).length === 0 || Object.keys(b).length === 0) return null;

  let divergence = 0;
  for (const token of tokens) {
    const p = a[token] ?? 0;
    const q = b[token] ?? 0;
    const m = (p + q) / 2;
    if (p > 0) divergence += 0.5 * p * log2(p / m);
    if (q > 0) divergence += 0.5 * q * log2(q / m);
  }
  // The sum is mathematically in [0, 1] but floating point can land a hair over.
  return Math.min(1, Math.max(0, divergence));
}

/**
 * A likelihood in `(0, 1]` from a divergence.
 *
 * `tau` is the scale over which a divergence stops being noise: a divergence of
 * `tau` is a likelihood of about 0.37, and twice that is about 0.14. It is a
 * parameter rather than a derivation because the right value is an empirical
 * question — how far two runs of the *same* model diverge — and the honest
 * default is a round number the console can be argued with about.
 */
export function likelihoodFrom(divergence: number, tau: number): number {
  return Math.exp(-divergence / tau);
}

/**
 * The scale a divergence is read on.
 *
 * A tenth of a bit. Two runs of the same model over forty draws typically land
 * well under this; a different family lands well over it. Setting it is a
 * judgement, and the ADR says so rather than pretending it was measured.
 */
export const JSD_TAU = 0.1;

function log2(value: number): number {
  return Math.log(value) / Math.LN2;
}

/**
 * The token that came first in an answer, or null when there is none.
 *
 * Leading whitespace is trimmed and the rest is lowercased, because two draws
 * that differ only in whether the tokenizer kept a space are the same draw for
 * this purpose — and a distribution split between `" Paris"` and `"Paris"` is a
 * distribution of one thing reported as two.
 */
export function firstTokenOf(text: string): string | null {
  const trimmed = text.trimStart();
  if (trimmed === '') return null;
  const [first] = trimmed.split(/\s+/u);
  return first === undefined ? null : first.toLowerCase();
}
