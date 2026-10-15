import {
  VERDICT_BANDS,
  type FamilyPosterior,
  type ProbeSignal,
  type VerificationResult,
  type VerificationVerdict,
} from '@contracts';

import type { BarListItem } from '@web/components/patterns/BarList.tsx';
import type { Tone } from '@web/components/patterns/tone.ts';
import { formatRatio } from '@web/lib/format.ts';

/**
 * Verification vocabulary and shaping.
 *
 * One rule shapes the whole page (ADR-0017): a verification never answers yes or
 * no. The evidence is a distribution over model families, and the verdict is the
 * *band* that distribution falls into — so every label here describes a degree of
 * agreement, and every number is posterior mass rather than a proof.
 *
 * The second rule is why the posterior is the headline and the model's own name
 * is not: an endpoint's self-identification is not evidence (ADR-0017 rule 2).
 * What it claims appears only as the hypothesis under test — the `claimed` flag
 * on one bar — never as a conclusion.
 */

/* ---- URL ---- */

/** The result whose detail is open, so a finding is a link. */
export const RESULT_PARAM = 'verify';
export const SEARCH_PARAM = 'verify_q';
/** Set while the launcher is open, so opening it is a step the back button undoes. */
export const LAUNCH_PARAM = 'new';

/* ---- Verdict bands ---- */

export const VERDICT_LABELS: Record<VerificationVerdict, string> = {
  match: 'Match',
  'family-only': 'Family only',
  uncertain: 'Uncertain',
  mismatch: 'Mismatch',
  insufficient: 'Insufficient',
};

export const VERDICT_TONES: Record<VerificationVerdict, Tone> = {
  match: 'success',
  'family-only': 'info',
  uncertain: 'warning',
  mismatch: 'danger',
  insufficient: 'neutral',
};

/** What each band means, in the words a reader needs rather than the enum's. */
export const VERDICT_HINTS: Record<VerificationVerdict, string> = {
  match:
    'The behaviour lines up with the claimed family closely enough to take the label at face value.',
  'family-only':
    'The evidence points at the family but not the exact model — a sibling, a different size, or a quantised build.',
  uncertain: 'The probes neither confirm nor contradict the label. More evidence would settle it.',
  mismatch: 'The behaviour contradicts the claimed family. Treat the label as unreliable.',
  insufficient: 'Too few probes produced usable evidence to say anything either way.',
};

/** How strong a band is, weakest first — `VERDICT_BANDS` order as an index. */
export function verdictRank(verdict: VerificationVerdict): number {
  return VERDICT_BANDS.indexOf(verdict);
}

/* ---- Posterior ---- */

/**
 * The posterior as a bar list, strongest family first.
 *
 * `share` is the posterior score itself: the entries are already a distribution
 * summing to about one, so scaling them again would misstate the mass. The
 * claimed family keeps the accent so it is findable at a glance without the
 * chart implying it won.
 */
export function posteriorItems(posterior: readonly FamilyPosterior[]): readonly BarListItem[] {
  return [...posterior]
    .sort((left, right) => right.score - left.score)
    .map((entry) => ({
      key: entry.family,
      label: entry.claimed ? `${entry.family} · claimed` : entry.family,
      value: formatRatio(entry.score),
      share: entry.score,
      tone: entry.claimed ? 'accent' : 'neutral',
    }));
}

/** The mass sitting on the family the endpoint claimed. */
export function claimedMass(result: VerificationResult): number {
  return result.posterior.find((entry) => entry.claimed)?.score ?? 0;
}

/** The strongest family, whether or not it is the claimed one. */
export function leadingFamily(result: VerificationResult): FamilyPosterior | null {
  return [...result.posterior].sort((left, right) => right.score - left.score)[0] ?? null;
}

/**
 * One sentence stating the band and where the mass landed.
 *
 * Deliberately about the evidence, not the endpoint: it says what the probes
 * found, and the claimed name appears only as the thing being tested. That is
 * ADR-0017 rule 2, as a string.
 */
export function verdictHeadline(result: VerificationResult): string {
  const mass = formatRatio(claimedMass(result));
  const lead = leadingFamily(result);
  switch (result.verdict) {
    case 'match':
      return `${mass} of the posterior sits on ${result.claimedFamily}, and the probes agree.`;
    case 'family-only':
      return `The evidence points at the ${result.claimedFamily} family, but not at this exact model.`;
    case 'uncertain':
      return `The probes are inconclusive — ${mass} on ${result.claimedFamily} is not enough to confirm or deny it.`;
    case 'mismatch':
      return lead === null
        ? 'The behaviour contradicts the claimed family.'
        : `The behaviour fits ${lead.family} better than the claimed ${result.claimedFamily}.`;
    case 'insufficient':
      return 'Too few probes produced usable evidence to reach a band.';
  }
}

/* ---- Signals ---- */

export interface SignalTally {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
}

export function tallySignals(signals: readonly ProbeSignal[]): SignalTally {
  const passed = signals.filter((signal) => signal.passed).length;
  return { total: signals.length, passed, failed: signals.length - passed };
}

/** A probe's measurement on its own scale, or `—` when it is not numeric. */
export function measurementLabel(signal: ProbeSignal): string {
  return signal.measurement === null ? '—' : formatRatio(signal.measurement, 2);
}

/* ---- Labels and export ---- */

/** `anthropic` for a provider-default model, `openai · gpt-4.1` otherwise. */
export function endpointLabel(result: { providerId: string; model: string }): string {
  return result.model === '' ? result.providerId : `${result.providerId} · ${result.model}`;
}

/** JSON for a result, so a finding can leave the console intact. */
export function resultToJson(result: VerificationResult): string {
  return JSON.stringify(result, null, 2);
}

export function exportFilename(result: VerificationResult, extension: string): string {
  const slug = `${result.providerId}-${result.model}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return `${slug === '' ? result.id : slug}.${extension}`;
}
