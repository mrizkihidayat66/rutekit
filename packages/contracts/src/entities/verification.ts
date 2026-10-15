import { z } from 'zod';
import { isoDateTimeSchema } from '../common.ts';

/**
 * Model-authenticity verification (FR-10.x).
 *
 * Rather than asking an endpoint what it is — the one thing a mislabelled
 * reseller will always answer honestly about — we accumulate behavioural
 * evidence and score a posterior over model families. The verdict is a band,
 * never a boolean.
 */

export const probeSignalKindSchema = z.enum([
  'single-token-distribution',
  'tokenizer-surface',
  'api-surface',
  'self-consistency',
  'negative-control',
  'capability-boundary',
]);

export const verificationVerdictSchema = z.enum([
  'match',
  'family-only',
  'uncertain',
  'mismatch',
  'insufficient',
]);

/** One probe outcome. `confidence` is the posterior mass this signal supports. */
export const probeSignalSchema = z.object({
  kind: probeSignalKindSchema,
  label: z.string(),
  /** Whether the observed behaviour was consistent with the claimed model. */
  passed: z.boolean(),
  confidence: z.number().min(0).max(1),
  detail: z.string(),
  /** Raw measured value, e.g. the JSD distance; null when not numeric. */
  measurement: z.number().nullable().default(null),
  samples: z.number().int().nonnegative(),
});

/** Posterior mass assigned to a candidate family. Bars sum to ~1 across the list. */
export const familyPosteriorSchema = z.object({
  family: z.string(),
  score: z.number().min(0).max(1),
  /** True for the family the endpoint claimed to be. */
  claimed: z.boolean(),
});

export const verificationResultSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  model: z.string(),
  /** The family the endpoint claims; what we are testing against. */
  claimedFamily: z.string(),
  verdict: verificationVerdictSchema,
  /** Posterior mass on the claimed family; drives the verdict band. */
  confidence: z.number().min(0).max(1),
  posterior: z.array(familyPosteriorSchema),
  signals: z.array(probeSignalSchema),
  /** Total probe requests spent; shown because the method is query-bounded. */
  probesUsed: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  notes: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});

export type ProbeSignalKind = z.infer<typeof probeSignalKindSchema>;
export type ProbeSignal = z.infer<typeof probeSignalSchema>;
export type FamilyPosterior = z.infer<typeof familyPosteriorSchema>;
export type VerificationVerdict = z.infer<typeof verificationVerdictSchema>;
export type VerificationResult = z.infer<typeof verificationResultSchema>;

/** Verdict bands, weakest evidence first. Used to colour the badge. */
export const VERDICT_BANDS: readonly VerificationVerdict[] = [
  'insufficient',
  'mismatch',
  'uncertain',
  'family-only',
  'match',
];

/** How many probe requests each budget spends. */
export const probeBudgetSchema = z.enum(['quick', 'standard', 'deep']);
export type ProbeBudget = z.infer<typeof probeBudgetSchema>;

/**
 * What each budget costs, in requests.
 *
 * Here rather than only on the server because the launcher shows the price
 * *before* it is paid: a verification spends the operator's own quota, and "deep"
 * meaning two hundred requests is the kind of thing a person should read rather
 * than discover afterwards. The numbers are the contract's so the console and the
 * server cannot disagree about what a budget costs — and a server-side test
 * asserts these against the probe catalogue, so the two cannot drift silently.
 */
export const PROBE_BUDGET_COUNTS: Readonly<Record<ProbeBudget, number>> = {
  quick: 19,
  standard: 92,
  deep: 188,
};

/**
 * The fewest probes that must produce an observation, as a fraction.
 *
 * An endpoint answering four requests in five is an endpoint that is failing, and
 * a divergence computed from the fifth is a divergence computed from a sample
 * that is not representative of anything. Below this the verdict is
 * `insufficient`, whatever the posterior says.
 */
export const MIN_PROBE_SUCCESS_RATE = 0.8;
