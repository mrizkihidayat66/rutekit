import type { BaselineSubject, VerificationResult } from '@contracts';
import {
  PROBE_BUDGET_COUNTS,
  baselineSubjectSchema,
  baselinesResponseSchema,
  calibrationInputSchema,
  verificationInputSchema,
  verificationResultSchema,
  verificationsResponseSchema,
} from '@contracts';

import { isoAt } from '../clock.ts';
import { db, matches, paginate, sortBy } from '../db.ts';
import { http } from '../net.ts';
import { bodyOf, listParams, notFound, paramId, respond, route, searchParams, uid } from './helpers.ts';

/**
 * The Model Verification page, mocked (FR-10.x).
 *
 * Its own domain, like `chat`, `studio` and `benchmark`: the Tools section's
 * pages have separate backends landing in separate groups, and this is the last
 * one to leave `tools`.
 *
 * **The mock's baseline list is empty on purpose.** A fresh install has no
 * reference distributions — they are measured from an endpoint the operator
 * trusts, which is a real request against a real account — so the honest mock is
 * one where `verifications/baselines` answers with nothing and a verification
 * comes back `insufficient` with the note about calibrating. Filling it with
 * invented numbers would make the page look alive and teach the operator to
 * expect a verdict they cannot get.
 */

/** What rutekit would have measured, once an operator has calibrated it. */
const baselines = new Map<string, BaselineSubject>();

export const verificationHandlers = [
  http.get(route('verifications'), ({ request }) => {
    const params = searchParams(request);
    const { cursor, limit, sort, direction } = listParams(request);
    const q = params.get('q') ?? '';
    const items = db.verifications.filter((entry) => matches([entry.model, entry.providerId, entry.claimedFamily, entry.id], q));
    return respond(verificationsResponseSchema, paginate(sortBy(items, sort, direction), { cursor, limit }));
  }),

  http.post(route('verifications'), async ({ request }) => {
    const input = verificationInputSchema.parse(await bodyOf(request));
    const result = runVerification(input);
    db.verifications.unshift(result);
    return respond(verificationResultSchema, result);
  }),

  /**
   * The reference distributions rutekit has measured.
   *
   * Empty until an operator calibrates, which is the state a fresh install is
   * actually in — and the reason the launcher's verification comes back
   * `insufficient` rather than with a verdict.
   */
  http.get(route('verificationsBaselines'), () =>
    respond(baselinesResponseSchema, {
      subjects: [...baselines.values()],
      knownFamilies: KNOWN_FAMILIES,
    }),
  ),

  /**
   * Measure a reference from an endpoint the operator trusts.
   *
   * The distributions here are illustrative — a mock has no model to draw tokens
   * from — but everything around them is the real shape: two probes, a sample
   * count, the endpoint it came from, and the family flag that decides what a
   * verdict measured against it can claim.
   */
  http.post(route('verificationsCalibrate'), async ({ request }) => {
    const input = calibrationInputSchema.parse(await bodyOf(request));
    const family = KNOWN_FAMILIES.some((name) => name === input.subject.toLowerCase());
    const subject: BaselineSubject = {
      subject: input.subject,
      family,
      probes: [
        {
          probeId: 'dist-main',
          distribution: { paris: 0.42, the: 0.18, 'a': 0.12, france: 0.1, located: 0.08, city: 0.06, its: 0.04 },
          samples: input.budget === 'quick' ? 6 : 40,
        },
        {
          probeId: 'dist-unicode',
          distribution: { ありがとう: 0.38, 'ありがとうございます': 0.22, と: 0.16, 'ありがとう。': 0.12, 'どういたしまして': 0.12 },
          samples: input.budget === 'quick' ? 6 : 40,
        },
      ],
      calibratedAt: isoAt(0),
      measuredFrom: { providerId: input.providerId, model: input.model },
    };
    baselines.set(input.subject, subject);
    return respond(baselineSubjectSchema, subject);
  }),

  // Last, so the two literals above match first: MSW resolves in registration
  // order, and a `:id` route declared earlier would read `baselines` as an id.
  http.get(route('verification'), ({ params }) => {
    const result = db.verification(paramId(params));
    return result === undefined ? notFound('verification', paramId(params)) : respond(verificationResultSchema, result);
  }),
];

/** The families rutekit's probe table knows how to discriminate between. */
const KNOWN_FAMILIES: readonly string[] = ['anthropic', 'openai', 'google', 'meta'];

/** The rivals a posterior spreads residual mass over. */
function candidatesFor(claimed: string): readonly string[] {
  return [claimed, ...KNOWN_FAMILIES.filter((name) => name !== claimed.toLowerCase())];
}

/**
 * A verification, shaped the way the real one is.
 *
 * The important part is the fail-closed behaviour: with no baseline for the
 * claimed family, the two signals that need a reference report that they had
 * nothing to compare against, the posterior stays flat, and the verdict is
 * `insufficient` with the note about calibrating. That is what the page has to
 * show on a fresh install, and a mock that invented a verdict would hide it.
 */
function runVerification(input: {
  providerId: string;
  model: string;
  claimedFamily: string;
  budget: 'quick' | 'standard' | 'deep';
}): VerificationResult {
  const candidates = candidatesFor(input.claimedFamily);
  const baseline = baselines.get(input.claimedFamily);
  const calibrated = baseline !== undefined;
  const samples = input.budget === 'quick' ? 6 : input.budget === 'standard' ? 40 : 88;
  const used = PROBE_BUDGET_COUNTS[input.budget];

  const distributionSignals: VerificationResult['signals'] = calibrated
    ? [
        {
          kind: 'single-token-distribution',
          label: 'Single-token distribution',
          passed: true,
          confidence: 0.58,
          detail: 'JSD 0.061 bits from the claimed family reference — inside the 0.1 bit band.',
          measurement: 0.061,
          samples,
        },
        {
          kind: 'tokenizer-surface',
          label: 'Tokenizer surface',
          passed: true,
          confidence: 0.54,
          detail: 'JSD 0.074 bits from the claimed family reference — inside the 0.1 bit band.',
          measurement: 0.074,
          samples,
        },
      ]
    : [
        {
          kind: 'single-token-distribution',
          label: 'Single-token distribution',
          passed: false,
          confidence: 0,
          detail: `No reference distribution for ${input.claimedFamily}, so there is nothing to compare against. Calibrate it first.`,
          measurement: null,
          samples,
        },
        {
          kind: 'tokenizer-surface',
          label: 'Tokenizer surface',
          passed: false,
          confidence: 0,
          detail: `No reference distribution for ${input.claimedFamily}, so there is nothing to compare against. Calibrate it first.`,
          measurement: null,
          samples,
        },
      ];

  const tableSignals: VerificationResult['signals'] = [
    {
      kind: 'negative-control',
      label: 'Negative control',
      passed: true,
      confidence: 0.55,
      detail: 'The endpoint declined the control prompt, as this family is expected to.',
      measurement: null,
      samples: 1,
    },
    {
      kind: 'api-surface',
      label: 'API surface',
      passed: true,
      confidence: 0.55,
      detail: 'The endpoint refused a multi-choice request, as this family’s API does.',
      measurement: null,
      samples: 1,
    },
    {
      kind: 'capability-boundary',
      label: 'Capability boundary',
      passed: true,
      confidence: 0.52,
      detail: 'The endpoint managed rung 5 of 6; this family is expected to reach rung 5.',
      measurement: 0.83,
      samples: 6,
    },
    {
      kind: 'self-consistency',
      label: 'Self-consistency',
      passed: true,
      confidence: 0.5,
      detail: 'The two halves agreed on 100% of the paraphrases; this family is expected around 85%.',
      measurement: 1,
      samples: 4,
    },
  ];

  const signals = [...distributionSignals, ...tableSignals];
  const usable = signals.filter((signal) => signal.confidence > 0).length;

  // A uniform prior, multiplied by nothing but the table signals when there is no
  // reference — which is why an uncalibrated run lands flat rather than skewed.
  const scores = new Map<string, number>(candidates.map((family) => [family, 1]));
  for (const family of candidates) {
    scores.set(family, family === input.claimedFamily && calibrated ? 6 : 1);
  }
  const total = [...scores.values()].reduce((sum, score) => sum + score, 0);

  return {
    id: uid('ver'),
    providerId: input.providerId,
    model: input.model,
    claimedFamily: input.claimedFamily,
    verdict: calibrated ? 'family-only' : 'insufficient',
    confidence: (scores.get(input.claimedFamily) ?? 0) / total,
    posterior: candidates.map((family) => ({
      family,
      score: (scores.get(family) ?? 0) / total,
      claimed: family === input.claimedFamily,
    })),
    signals,
    probesUsed: used,
    durationMs: used * 320,
    notes: calibrated
      ? 'The evidence points at the family. Confirming this exact model needs a reference measured from it, not just from the family.'
      : `Only ${String(usable)} of 2 required signals produced evidence. Calibrate a reference for this family, then verify again.`,
    createdAt: isoAt(0),
  };
}
