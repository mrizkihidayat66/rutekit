import type { FamilyPosterior, VerificationVerdict } from '@contracts';

import type { SignalResult } from './signals.ts';

/**
 * Accumulating evidence into a posterior, and reading a band off it (C12, FR-10.2).
 *
 * The arithmetic is deliberately small: a uniform prior, one likelihood per
 * signal per candidate, multiply, normalise. The interesting part is not the
 * arithmetic but the four rules around it, each of which exists because the
 * obvious alternative produces a confident answer where an honest one is "not
 * enough".
 *
 * **The claim earns no credit for being made.** The prior is uniform across
 * candidates, including the one the endpoint claims to be. ADR-0017's second rule
 * is that an endpoint's self-identification is not evidence, and a prior boost
 * for the claim would smuggle exactly that back in — a reseller that names a
 * family would start every verification ahead.
 *
 * **A signal that learned nothing multiplies by one.** Neutral likelihoods leave
 * the posterior where it was, so a fresh install with no baselines produces a flat
 * posterior and the band says `insufficient`. The alternative — treating an
 * unmeasured candidate as unlikely — is how a verification tool ends up declaring
 * every endpoint a fake.
 *
 * **`match` needs a reference measured from the model itself.** A family baseline
 * can confirm the family and can never confirm the exact build, because it was
 * never measured from one. So the top band requires a model-level baseline on the
 * claimed family; with only a family baseline the ceiling is `family-only`. That
 * is the difference the contract's two bands were for.
 *
 * **Too little usable evidence is `insufficient`, not `uncertain`.** They read
 * similarly and mean opposite things: `uncertain` is "the probes disagreed", and
 * `insufficient` is "the probes did not run". Collapsing them would let a
 * verification that spent six requests claim the same authority as one that spent
 * a hundred.
 */

/**
 * Fewest signals compared against something **measured** before any band other
 * than `insufficient` is reachable.
 *
 * One, and the reason it is not zero is the whole fail-closed discipline. Four of
 * the six signals read a table rutekit wrote by hand — they can confirm that an
 * endpoint behaves the way rutekit believes a family behaves, and that is not a
 * verification of anything, because a model fine-tuned to imitate a family passes
 * them all. Only the distribution probes compare against a reference measured
 * from a real endpoint. Without at least one of those, the honest answer is that
 * nothing has been verified, whatever the table signals say.
 *
 * This is why a fresh install reports `insufficient` rather than a confident
 * verdict: the four signals that need no reference agree, and agreement among
 * constants is not evidence.
 */
export const MIN_MEASURED_SIGNALS = 1;

/**
 * Fraction of probes that must have produced an observation.
 *
 * The fail-closed floor the roadmap names. An endpoint answering four requests in
 * five is an endpoint that is failing, and a divergence computed from the fifth
 * is a divergence computed from a sample that is not representative of anything.
 */
export const MIN_SUCCESS_RATE = 0.8;

/** Posterior mass on the claim at or above which the family is confirmed. */
const MATCH_MASS = 0.7;
/** Mass at or above which the family — but not the exact model — is confirmed. */
const FAMILY_MASS = 0.45;
/** Mass below which the claim is contradicted rather than merely unsupported. */
const MISMATCH_MASS = 0.15;

export interface PosteriorInput {
  readonly claimedFamily: string;
  readonly candidates: readonly string[];
  readonly signals: readonly SignalResult[];
  /** Requests that produced an observation, over requests attempted. */
  readonly probesSucceeded: number;
  readonly probesUsed: number;
  /**
   * How many signals compared against something measured.
   *
   * Passed in rather than derived here because "measured" is a fact about how a
   * signal was produced, which this file has no way to see.
   */
  readonly measuredSignals: number;
  /**
   * Whether a reference measured from this exact model exists.
   *
   * The claimed family's own baseline is not enough: `match` is a claim about a
   * build, and a family reference was never measured from one.
   */
  readonly hasModelBaseline: boolean;
}

export interface PosteriorOutcome {
  readonly posterior: readonly FamilyPosterior[];
  readonly verdict: VerificationVerdict;
  /** Posterior mass on the claimed family; drives the band. */
  readonly confidence: number;
  readonly measuredSignals: number;
  readonly notes: string | null;
}

/**
 * The posterior over candidates, uniform prior times every likelihood.
 *
 * A candidate no signal had an opinion about keeps the prior, which is what makes
 * the distribution flat on a fresh install rather than skewed toward whichever
 * family happened to have a reference.
 */
export function accumulate(input: PosteriorInput): readonly FamilyPosterior[] {
  const scores = new Map<string, number>(input.candidates.map((family) => [family, 1]));

  for (const result of input.signals) {
    for (const family of input.candidates) {
      const likelihood = result.likelihoods[family] ?? 1;
      scores.set(family, (scores.get(family) ?? 1) * likelihood);
    }
  }

  const total = [...scores.values()].reduce((sum, score) => sum + score, 0);
  // Every likelihood is positive, so a zero total is not reachable in practice —
  // but a flat posterior is the right answer if it ever were, and dividing by
  // zero would produce `NaN` scores the console would render as blank bars.
  const share = (score: number): number =>
    total === 0 ? 1 / Math.max(1, input.candidates.length) : score / total;

  return input.candidates.map((family) => ({
    family,
    score: share(scores.get(family) ?? 0),
    claimed: family === input.claimedFamily,
  }));
}

/**
 * The band a posterior falls into.
 *
 * Ordered so the fail-closed checks come first: an under-evidenced run cannot
 * reach any band, whatever its numbers say.
 */
export function verdictOf(
  posterior: readonly FamilyPosterior[],
  input: Pick<
    PosteriorInput,
    'claimedFamily' | 'probesSucceeded' | 'probesUsed' | 'hasModelBaseline' | 'measuredSignals'
  >,
): VerificationVerdict {
  const mass = posterior.find((entry) => entry.claimed)?.score ?? 0;
  const successRate =
    input.probesUsed === 0 ? 0 : input.probesSucceeded / Math.max(1, input.probesUsed);

  if (input.measuredSignals < MIN_MEASURED_SIGNALS || successRate < MIN_SUCCESS_RATE) {
    return 'insufficient';
  }
  if (mass >= MATCH_MASS) {
    // A family reference cannot confirm a build, so the ceiling without a
    // model-level reference is the band below.
    return input.hasModelBaseline ? 'match' : 'family-only';
  }
  if (mass >= FAMILY_MASS) return 'family-only';
  if (mass < MISMATCH_MASS) return 'mismatch';
  return 'uncertain';
}

/** Why a band came out the way it did, when that is not obvious from the numbers. */
function notesFor(
  verdict: VerificationVerdict,
  input: Pick<PosteriorInput, 'probesSucceeded' | 'probesUsed' | 'hasModelBaseline' | 'measuredSignals'>,
): string | null {
  const successRate =
    input.probesUsed === 0 ? 0 : input.probesSucceeded / Math.max(1, input.probesUsed);

  if (input.measuredSignals < MIN_MEASURED_SIGNALS) {
    return 'No signal compared against a measured reference, so nothing has been verified. Calibrate a reference for this family, then verify again.';
  }
  if (successRate < MIN_SUCCESS_RATE) {
    return `Only ${(successRate * 100).toFixed(0)}% of the ${String(input.probesUsed)} probes produced an observation; ${(MIN_SUCCESS_RATE * 100).toFixed(0)}% is the floor.`;
  }
  if (verdict === 'family-only' && !input.hasModelBaseline) {
    return 'The evidence points at the family. Confirming this exact model needs a reference measured from it, not just from the family.';
  }
  return null;
}

export function posteriorOf(input: PosteriorInput): PosteriorOutcome {
  const posterior = accumulate(input);
  const verdict = verdictOf(posterior, input);

  return {
    posterior,
    verdict,
    confidence: posterior.find((entry) => entry.claimed)?.score ?? 0,
    measuredSignals: input.measuredSignals,
    notes: notesFor(verdict, input),
  };
}
