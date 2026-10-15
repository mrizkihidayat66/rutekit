import type { ProbeSignal, ProbeSignalKind } from '@contracts';

import type { VerificationBaselineRow } from '@server/persistence/verification.ts';

import {
  JSD_TAU,
  firstTokenOf,
  jensenShannon,
  likelihoodFrom,
  toDistribution,
} from './divergence.ts';
import { LADDER, familyOf } from './families.ts';
import type { ProbeOutcome } from './probe-runner.ts';
import { MIN_DISTRIBUTION_SAMPLES, type ProbeSpec } from './probes.ts';

/**
 * Turning probe answers into evidence (C12, FR-10.1–10.2).
 *
 * Each probe produces one signal, and each signal produces **a likelihood for
 * every candidate family** rather than a single pass or fail. That is the shape
 * the posterior needs: a signal that only says "this matched the claim" cannot
 * move mass onto a rival, and a verdict that can never name a rival is a verdict
 * that can only agree or shrug.
 *
 * **A missing reference is neutral, not damning.** When there is no baseline for
 * a candidate, that candidate's likelihood is 1 — the observation is equally
 * likely under it, so it neither gains nor loses. The alternative, treating
 * "unmeasured" as "unlikely", would make a fresh install confidently declare
 * every endpoint a mismatch, which is the exact failure fail-closed discipline
 * exists to prevent.
 *
 * **Two signals are strong and four are weak, and the code says which is which.**
 * The two that compare a distribution against something actually measured
 * (`single-token-distribution`, `tokenizer-surface`) can separate a family from
 * its rivals on evidence. The four that read the curated table in `families.ts`
 * are comparing against a constant rutekit wrote by hand — so their likelihood
 * ratios are deliberately gentle, and a verdict resting only on them cannot
 * reach `match`.
 */

/** How much a table-driven signal moves the posterior when it agrees or disagrees. */
const AGREES = 0.85;
const DISAGREES = 0.25;

/** How far a rung the model managed may be from the expected one and still pass. */
const LADDER_TOLERANCE = 1;
/** The scale a rung distance is read on, in rungs. */
const LADDER_TAU = 1.5;

/** How far an observed agreement rate may be from the expected one and still pass. */
const CONSISTENCY_TOLERANCE = 0.2;
/** The scale an agreement gap is read on. */
const CONSISTENCY_TAU = 0.25;

/** One signal, with the likelihood it assigns to each candidate family. */
export interface SignalResult {
  /** The contract's shape, for the console. */
  readonly signal: ProbeSignal;
  /** Likelihood per candidate, in `(0, 1]`. Missing candidates are neutral. */
  readonly likelihoods: Readonly<Record<string, number>>;
  /**
   * Whether this signal produced evidence at all.
   *
   * Distinct from `signal.passed`: a probe that could not run has no opinion
   * either way, and the verdict's `insufficient` band is driven by how many
   * signals actually had one rather than by how many disagreed.
   */
  readonly usable: boolean;
  /**
   * Whether that evidence was compared against something **measured**.
   *
   * The distinction the whole fail-closed discipline rests on. Four of the six
   * signals read the curated table in `families.ts` — a constant rutekit wrote by
   * hand — so they can only ever confirm that an endpoint behaves the way rutekit
   * believes a family behaves. The two distribution probes compare against a
   * reference measured from a real endpoint, and a verdict resting on nothing but
   * constants is not a verification of anything. So this flag, not `usable`, is
   * what a band above `insufficient` requires.
   */
  readonly measured: boolean;
}

export interface SignalContext {
  readonly claimedFamily: string;
  readonly candidates: readonly string[];
  /** Every reference for one subject, keyed by probe id. */
  readonly baselinesFor: (subject: string) => ReadonlyMap<string, VerificationBaselineRow>;
}

/** Neutral for every candidate: the shape a signal takes when it learned nothing. */
function neutral(candidates: readonly string[]): Record<string, number> {
  return Object.fromEntries(candidates.map((family) => [family, 1]));
}

/**
 * The confidence a signal reports: the claimed family's share of its own
 * likelihoods.
 *
 * That is the contract's own reading — "the posterior mass this signal supports"
 * — and it is the useful one: a signal that gives every candidate the same
 * likelihood reports zero, because it moved nothing, however large its raw
 * numbers are.
 */
function confidenceFrom(
  likelihoods: Readonly<Record<string, number>>,
  claimed: string,
): number {
  const values = Object.values(likelihoods);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 0;
  return (likelihoods[claimed] ?? 0) / total;
}

/** Build the contract's signal shape from the parts each reading produces. */
function signalOf(input: {
  kind: ProbeSignalKind;
  label: string;
  passed: boolean;
  confidence: number;
  detail: string;
  measurement: number | null;
  samples: number;
}): ProbeSignal {
  return {
    kind: input.kind,
    label: input.label,
    passed: input.passed,
    confidence: input.confidence,
    detail: input.detail,
    measurement: input.measurement,
    samples: input.samples,
  };
}

/* ---- The two baseline-driven signals ---- */

/**
 * A divergence between the observed first tokens and each candidate's reference.
 *
 * The claimed family's divergence is the one reported as the measurement, and
 * `null` when the claimed family has no reference — which is the honest answer
 * for a fresh install rather than a zero.
 */
function divergenceSignal(
  probe: ProbeSpec,
  outcomes: readonly ProbeOutcome[],
  context: SignalContext,
): SignalResult {
  const texts = outcomes.map((outcome) => outcome.text).filter((text): text is string => text !== null);
  const counts: Record<string, number> = {};
  let samples = 0;
  for (const text of texts) {
    const token = firstTokenOf(text);
    if (token === null) continue;
    counts[token] = (counts[token] ?? 0) + 1;
    samples += 1;
  }

  const observed = toDistribution(counts);

  if (samples < MIN_DISTRIBUTION_SAMPLES) {
    return {
      signal: signalOf({
        kind: probe.kind,
        label: probe.label,
        passed: false,
        confidence: 0,
        // Said plainly, because the number that would otherwise be reported here
        // is a divergence between two lists of one or two tokens each — and it
        // would read as confident evidence in the console.
        detail: `Only ${String(samples)} usable samples; ${String(MIN_DISTRIBUTION_SAMPLES)} are needed before a divergence means anything.`,
        measurement: null,
        samples,
      }),
      likelihoods: neutral(context.candidates),
      usable: false,
      measured: false,
    };
  }

  const likelihoods: Record<string, number> = {};
  let claimedDivergence: number | null = null;
  let compared = 0;

  for (const family of context.candidates) {
    const baseline = context.baselinesFor(family).get(probe.id);
    if (baseline === undefined) {
      // No reference for this family: the observation is equally likely under it.
      likelihoods[family] = 1;
      continue;
    }
    const divergence = jensenShannon(observed, baseline.distribution);
    if (divergence === null) {
      likelihoods[family] = 1;
      continue;
    }
    compared += 1;
    likelihoods[family] = likelihoodFrom(divergence, JSD_TAU);
    if (family === context.claimedFamily) claimedDivergence = divergence;
  }

  const passed = claimedDivergence !== null && claimedDivergence <= JSD_TAU;
  const detail =
    claimedDivergence === null
      ? `No reference distribution for ${context.claimedFamily}, so there is nothing to compare against. Calibrate it first.`
      : passed
        ? `JSD ${claimedDivergence.toFixed(3)} bits from the ${context.claimedFamily} reference — inside the ${JSD_TAU} bit band.`
        : `JSD ${claimedDivergence.toFixed(3)} bits from the ${context.claimedFamily} reference — outside the ${JSD_TAU} bit band.`;

  return {
    signal: signalOf({
      kind: probe.kind,
      label: probe.label,
      passed,
      confidence: compared === 0 ? 0 : confidenceFrom(likelihoods, context.claimedFamily),
      detail,
      measurement: claimedDivergence,
      samples,
    }),
    likelihoods,
    // Usable when at least one candidate had a reference: the signal did compare
    // something, even if the claimed family was not the one it could compare.
    usable: compared > 0,
    measured: compared > 0,
  };
}

/* ---- The four table-driven signals ---- */

/**
 * Whether the answer reads as a refusal.
 *
 * **A heuristic, and named as one.** There is no structured signal for "the
 * model declined" — a refusal is a sentence, and every family writes it
 * differently. The markers below are the openings that show up in practice; a
 * model that declines in an unusual way is scored as complying, which is a real
 * false-negative and the reason this signal is weighted as weakly as it is.
 *
 * Only the opening is read, because a compliant answer can easily *mention* a
 * refusal ("I can't speak for everyone, but here is how...") and a search over
 * the whole text would count that as declining.
 */
const REFUSAL_MARKERS: readonly string[] = [
  "i can't",
  'i cannot',
  "i can’t",
  "i won't",
  "i won’t",
  'i am not able',
  "i'm not able",
  'i am unable',
  "i'm unable",
  'i must decline',
  'i have to decline',
  'cannot help with',
  "can't help with",
  'not able to help',
  'unable to assist',
  'cannot assist',
  "can't assist",
  'against my guidelines',
];

const REFUSAL_WINDOW = 200;

export function readsAsRefusal(text: string): boolean {
  const opening = text.slice(0, REFUSAL_WINDOW).toLowerCase();
  return REFUSAL_MARKERS.some((marker) => opening.includes(marker));
}

function refusalSignal(
  probe: ProbeSpec,
  outcomes: readonly ProbeOutcome[],
  context: SignalContext,
): SignalResult {
  const first = outcomes[0];
  const text = first?.text ?? null;
  const claimed = familyOf(context.claimedFamily);

  if (text === null || text.trim() === '') {
    return {
      signal: signalOf({
        kind: probe.kind,
        label: probe.label,
        passed: false,
        confidence: 0,
        detail: first?.error ?? 'The control prompt produced no answer to read.',
        measurement: null,
        samples: 0,
      }),
      likelihoods: neutral(context.candidates),
      usable: false,
      measured: false,
    };
  }

  const refused = readsAsRefusal(text);
  const likelihoods: Record<string, number> = {};

  for (const family of context.candidates) {
    const fingerprint = familyOf(family);
    if (fingerprint === undefined || fingerprint === null) {
      // A candidate rutekit has no table entry for has no expectation, so the
      // observation neither supports nor contradicts it.
      likelihoods[family] = 1;
      continue;
    }
    const agrees = fingerprint.refuses === refused;
    likelihoods[family] = agrees ? AGREES : DISAGREES;
  }

  const passed = claimed !== null && claimed.refuses === refused;
  const detail =
    claimed === null
      ? `${refused ? 'Declined' : 'Answered'} — rutekit has no expectation for ${context.claimedFamily}, so this signal carries no weight.`
      : passed
        ? `The endpoint ${refused ? 'declined' : 'answered'}, as a ${claimed.name} model is expected to.`
        : `The endpoint ${refused ? 'declined' : 'answered'}, where a ${claimed.name} model is expected to ${claimed.refuses ? 'decline' : 'answer'}.`;

  return {
    signal: signalOf({
      kind: probe.kind,
      label: probe.label,
      passed,
      confidence: claimed === null ? 0 : confidenceFrom(likelihoods, context.claimedFamily),
      detail,
      measurement: null,
      samples: 1,
    }),
    likelihoods,
    usable: claimed !== null,
    measured: false,
  };
}

function acceptanceSignal(
  probe: ProbeSpec,
  outcomes: readonly ProbeOutcome[],
  context: SignalContext,
): SignalResult {
  const first = outcomes[0];
  const claimed = familyOf(context.claimedFamily);

  if (first === undefined) {
    return {
      signal: signalOf({
        kind: probe.kind,
        label: probe.label,
        passed: false,
        confidence: 0,
        detail: 'The acceptance probe did not run.',
        measurement: null,
        samples: 0,
      }),
      likelihoods: neutral(context.candidates),
      usable: false,
      measured: false,
    };
  }

  // The observation is whether the request was refused at all — the one
  // structural difference between these APIs that survives the pivot. The
  // provider's own error *text* does not, because rutekit rewrites an upstream
  // failure into its own sentence before anything reads it.
  const accepted = first.error === null;
  const likelihoods: Record<string, number> = {};

  for (const family of context.candidates) {
    const fingerprint = familyOf(family);
    if (fingerprint === null) {
      likelihoods[family] = 1;
      continue;
    }
    likelihoods[family] =
      fingerprint.acceptsMultipleChoices === accepted ? AGREES : DISAGREES;
  }

  const passed = claimed !== null && claimed.acceptsMultipleChoices === accepted;
  const detail =
    claimed === null
      ? `The endpoint ${accepted ? 'accepted' : 'refused'} a multi-choice request — rutekit has no expectation for ${context.claimedFamily}.`
      : passed
        ? `The endpoint ${accepted ? 'accepted' : 'refused'} a multi-choice request, as this family's API does.`
        : `The endpoint ${accepted ? 'accepted' : 'refused'} a multi-choice request, where this family's API is expected to ${claimed.acceptsMultipleChoices ? 'accept' : 'refuse'} it.`;

  return {
    signal: signalOf({
      kind: probe.kind,
      label: probe.label,
      passed,
      confidence: claimed === null ? 0 : confidenceFrom(likelihoods, context.claimedFamily),
      detail,
      measurement: null,
      samples: 1,
    }),
    likelihoods,
    usable: claimed !== null,
    measured: false,
  };
}

/**
 * Whether one ladder answer is correct.
 *
 * The answers are checkable, which is the whole reason this probe exists: a
 * capability boundary is only a signal if "managed it" is a fact rather than an
 * impression.
 *
 * **The numeric rungs read the *last* number in the answer.** That is a small
 * rule with a real consequence: a model that shows its working legitimately
 * restates the numbers from the question, so looking for the expected value
 * anywhere would pass almost anything, and looking for it as the *only* number
 * would fail every model that works step by step. The last number is where an
 * answer puts its result — `"45+30 = 75 km/h"` ends at 75, and so does
 * `"The answer is 75"`, while `"It is 38 or 39"` ends at 39 and is rightly
 * counted as a hedge rather than a result.
 *
 * The text rungs are substring checks against the expected string, which is the
 * only thing there is to check for a reversal or a substitution.
 */
export function rungPassed(rung: string, text: string): boolean {
  const answer = text.trim().toLowerCase();
  if (answer === '') return false;

  const lastNumber = (expected: number): boolean => {
    const numbers = answer.match(/-?\d+(?:\.\d+)?/gu);
    const last = numbers?.at(-1);
    return last !== undefined && Number.parseFloat(last) === expected;
  };

  switch (rung) {
    case 'count-letters':
      return lastNumber(3);
    case 'two-step-arithmetic':
      return lastNumber(38);
    case 'three-step-arithmetic':
      return lastNumber(75);
    case 'reverse-word':
      return answer.includes('esuohthgil');
    case 'unseen-transformation':
      return answer.includes('tjbrp');
    case 'nested-logic':
      // Both words, because the rung asks for a verdict *and* a sentence: an
      // answer that only says "no" has not demonstrated the reasoning.
      return /\bno\b/u.test(answer) && !/\byes\b/u.test(answer);
    default:
      return false;
  }
}

function ladderSignal(
  probe: ProbeSpec,
  outcomes: readonly ProbeOutcome[],
  context: SignalContext,
): SignalResult {
  // The rung the model still managed, or -1 when it failed the first one.
  let highest = -1;
  for (let index = 0; index < probe.prompts.length; index += 1) {
    const rung = LADDER[index];
    const outcome = outcomes[index];
    if (rung === undefined || outcome === undefined) continue;
    if (outcome.text !== null && rungPassed(rung, outcome.text)) highest = index;
  }

  const claimed = familyOf(context.claimedFamily);
  const expectedIndex = claimed === null ? -1 : LADDER.indexOf(claimed.expectedRung);

  if (claimed === null || expectedIndex === -1) {
    return {
      signal: signalOf({
        kind: probe.kind,
        label: probe.label,
        passed: false,
        confidence: 0,
        detail:
          claimed === null
            ? `The endpoint managed ${describeRung(highest)} — rutekit has no expectation for ${context.claimedFamily}.`
            : `rutekit has no expected rung recorded for ${claimed.name}.`,
        measurement: null,
        samples: probe.prompts.length,
      }),
      likelihoods: neutral(context.candidates),
      usable: false,
      measured: false,
    };
  }

  const likelihoods: Record<string, number> = {};
  for (const family of context.candidates) {
    const fingerprint = familyOf(family);
    const index = fingerprint === null ? -1 : LADDER.indexOf(fingerprint.expectedRung);
    if (index === -1) {
      likelihoods[family] = 1;
      continue;
    }
    likelihoods[family] = likelihoodFrom(Math.abs(highest - index) / LADDER_TAU, 1);
  }

  const distance = Math.abs(highest - expectedIndex);
  const passed = distance <= LADDER_TOLERANCE;

  return {
    signal: signalOf({
      kind: probe.kind,
      label: probe.label,
      passed,
      confidence: confidenceFrom(likelihoods, context.claimedFamily),
      detail: `The endpoint managed ${describeRung(highest)}; a ${claimed.name} model is expected to reach ${describeRung(expectedIndex)}.`,
      // Normalised so the number is on the same 0–1 scale as every other
      // measurement the console renders, rather than a rung index.
      measurement: LADDER.length === 0 ? 0 : Math.max(0, highest + 1) / LADDER.length,
      samples: probe.prompts.length,
    }),
    likelihoods,
    usable: true,
    measured: false,
  };
}

function describeRung(index: number): string {
  return index < 0 ? 'nothing on the ladder' : `rung ${String(index + 1)} of ${String(LADDER.length)}`;
}

function agreementSignal(
  probe: ProbeSpec,
  outcomes: readonly ProbeOutcome[],
  context: SignalContext,
): SignalResult {
  const answers = outcomes
    .map((outcome) => outcome.text)
    .filter((text): text is string => text !== null)
    .map((text) => text.trim().toLowerCase().replaceAll(/[^a-z0-9]/gu, ''));

  const claimed = familyOf(context.claimedFamily);

  // Split-half: the answers are split down the middle and the halves compared, so
  // the measure is about whether the endpoint agrees *with itself* rather than
  // about whether any single answer was right.
  const half = Math.floor(answers.length / 2);
  if (half === 0) {
    return {
      signal: signalOf({
        kind: probe.kind,
        label: probe.label,
        passed: false,
        confidence: 0,
        detail: 'Too few paraphrase answers to compare the two halves.',
        measurement: null,
        samples: answers.length,
      }),
      likelihoods: neutral(context.candidates),
      usable: false,
      measured: false,
    };
  }

  const first = answers.slice(0, half);
  const second = answers.slice(-half);
  let agree = 0;
  for (let index = 0; index < half; index += 1) {
    if (first[index] === second[index]) agree += 1;
  }
  const agreement = agree / half;

  if (claimed === null) {
    return {
      signal: signalOf({
        kind: probe.kind,
        label: probe.label,
        passed: false,
        confidence: 0,
        detail: `The two halves agreed on ${(agreement * 100).toFixed(0)}% of the paraphrases — rutekit has no expectation for ${context.claimedFamily}.`,
        measurement: agreement,
        samples: answers.length,
      }),
      likelihoods: neutral(context.candidates),
      usable: false,
      measured: false,
    };
  }

  const likelihoods: Record<string, number> = {};
  for (const family of context.candidates) {
    const fingerprint = familyOf(family);
    likelihoods[family] =
      fingerprint === null
        ? 1
        : likelihoodFrom(
            Math.abs(agreement - fingerprint.selfConsistency) / CONSISTENCY_TAU,
            1,
          );
  }

  const gap = Math.abs(agreement - claimed.selfConsistency);

  return {
    signal: signalOf({
      kind: probe.kind,
      label: probe.label,
      passed: gap <= CONSISTENCY_TOLERANCE,
      confidence: confidenceFrom(likelihoods, context.claimedFamily),
      detail: `The two halves agreed on ${(agreement * 100).toFixed(0)}% of the paraphrases; a ${claimed.name} model is expected around ${(claimed.selfConsistency * 100).toFixed(0)}%.`,
      measurement: agreement,
      samples: answers.length,
    }),
    likelihoods,
    usable: true,
    measured: false,
  };
}

/* ---- The dispatcher ---- */

/** The signal one probe produced, from its outcomes and the references at hand. */
export function signalFor(
  probe: ProbeSpec,
  outcomes: readonly ProbeOutcome[],
  context: SignalContext,
): SignalResult {
  switch (probe.reading) {
    case 'first-token-distribution':
      return divergenceSignal(probe, outcomes, context);
    case 'refusal':
      return refusalSignal(probe, outcomes, context);
    case 'parameter-acceptance':
      return acceptanceSignal(probe, outcomes, context);
    case 'ladder':
      return ladderSignal(probe, outcomes, context);
    case 'agreement':
      return agreementSignal(probe, outcomes, context);
  }
}
