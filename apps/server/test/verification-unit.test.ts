import { describe, expect, it } from 'vitest';
import { PROBE_BUDGET_COUNTS, type FamilyPosterior } from '@contracts';

import {
  JSD_TAU,
  firstTokenOf,
  jensenShannon,
  likelihoodFrom,
  toDistribution,
} from '@server/verification/divergence.ts';
import { LADDER, candidatesFor, familyNames, familyOf } from '@server/verification/families.ts';
import {
  accumulate,
  posteriorOf,
  verdictOf,
} from '@server/verification/posterior.ts';
import { probeCount, probesFor } from '@server/verification/probes.ts';
import { readsAsRefusal, rungPassed, signalFor } from '@server/verification/signals.ts';

/**
 * The verification's pure parts (C12).
 *
 * These are the pieces where a mistake is invisible in a route test: a divergence
 * computed the wrong way still returns a number, a posterior that gave the claim
 * a head start still returns a band, and a probe catalogue that drifted from the
 * contract's price list still returns a verification. Each is asserted here on its
 * own terms.
 */

/* ---- Distributions and divergence ---- */

describe('the divergence', () => {
  it('is zero for two identical distributions', () => {
    const a = toDistribution({ paris: 4, the: 2, france: 1 });
    expect(jensenShannon(a, a)).toBeCloseTo(0, 6);
  });

  it('is symmetric', () => {
    // KL is not, which is the reason JSD is the measure here: a reference with
    // mass where the sample has none would make KL infinite.
    const a = toDistribution({ paris: 10, the: 1 });
    const b = toDistribution({ london: 10, the: 1 });
    expect(jensenShannon(a, b)).toBeCloseTo(jensenShannon(b, a) ?? -1, 6);
  });

  it('approaches its ceiling of one bit for disjoint supports', () => {
    const a = toDistribution({ paris: 10 });
    const b = toDistribution({ london: 10 });
    const divergence = jensenShannon(a, b);
    expect(divergence).not.toBeNull();
    // Bounded rather than infinite — which is what makes it usable as a
    // likelihood without a special case for a token that never appeared.
    expect(divergence ?? 0).toBeGreaterThan(0.9);
    expect(divergence ?? 1).toBeLessThanOrEqual(1);
  });

  it('is small for two draws from the same shape', () => {
    const a = toDistribution({ paris: 20, the: 10, france: 8, a: 2 });
    const b = toDistribution({ paris: 19, the: 11, france: 8, a: 2 });
    expect(jensenShannon(a, b) ?? 1).toBeLessThan(JSD_TAU);
  });

  it('smooths, so a token in one and not the other does not make the supports disjoint', () => {
    // Without the floor every comparison would find disjoint supports somewhere
    // and every divergence would sit near the ceiling.
    const a = toDistribution({ paris: 40 });
    const b = toDistribution({ paris: 39, france: 1 });
    expect(jensenShannon(a, b) ?? 1).toBeLessThan(0.5);
  });

  it('answers null rather than one when either side is empty', () => {
    // A divergence against nothing is a missing measurement, and reporting it as
    // 1 would let a probe that never ran count as strong evidence against the
    // claim.
    expect(jensenShannon({}, toDistribution({ a: 1 }))).toBeNull();
    expect(jensenShannon({}, {})).toBeNull();
  });

  it('turns a divergence into a likelihood in (0, 1]', () => {
    expect(likelihoodFrom(0, JSD_TAU)).toBe(1);
    expect(likelihoodFrom(JSD_TAU, JSD_TAU)).toBeCloseTo(Math.exp(-1), 6);
    expect(likelihoodFrom(1, JSD_TAU)).toBeGreaterThan(0);
    expect(likelihoodFrom(1, JSD_TAU)).toBeLessThan(0.001);
  });

  it('reads the first token, folding case and leading space', () => {
    // `" Paris"` and `"Paris"` are the same draw for this purpose; a distribution
    // split between them is one thing reported as two.
    expect(firstTokenOf(' Paris is the capital')).toBe('paris');
    expect(firstTokenOf('PARIS')).toBe('paris');
    expect(firstTokenOf('   ')).toBeNull();
    expect(firstTokenOf('')).toBeNull();
  });
});

/* ---- The curated families ---- */

describe('the family table', () => {
  it('knows the families the probe table can discriminate', () => {
    expect(familyNames()).toEqual(['anthropic', 'openai', 'google', 'meta']);
  });

  it('resolves a name case-insensitively, and refuses one it does not know', () => {
    expect(familyOf('Anthropic')?.name).toBe('anthropic');
    // Guessing a family from a model id is what the probes are for; the table is
    // what an operator's typed claim is resolved against.
    expect(familyOf('claude-3-opus-20240229')).toBeNull();
  });

  it('puts the claimed name first and every known family after it when nothing is measured', () => {
    // The claim is always in the list — a claim naming a family rutekit has never
    // heard of still gets a posterior, and the honest answer to it is `uncertain`.
    const candidates = candidatesFor('SomethingNew');
    expect(candidates[0]).toBe('SomethingNew');
    expect(candidates).toHaveLength(5);
    expect(new Set(candidates).size).toBe(5);
  });

  it('counts only measurable families as rivals', () => {
    // A family with no reference holding a full share of the prior is a family
    // the evidence can never move, so a perfect match would still cap at a
    // quarter of the mass. An unmeasured family is not a rival — rutekit has no
    // basis to prefer it or reject it.
    expect(candidatesFor('openai', ['openai'])).toEqual(['openai']);
    expect(candidatesFor('openai', ['openai', 'anthropic'])).toEqual(['openai', 'anthropic']);
    // A measured family that is not a known family name is not a rival either:
    // nothing in the probe table can say anything about it.
    expect(candidatesFor('openai', ['openai', 'gpt-4o-mini'])).toEqual(['openai']);
  });

  it('does not duplicate the claim when it names a known family', () => {
    const candidates = candidatesFor('anthropic');
    expect(candidates).toEqual(['anthropic', 'openai', 'google', 'meta']);
  });
});

/* ---- The probe catalogue ---- */

describe('the probe catalogue', () => {
  it('costs what the contract says it costs', () => {
    // The console reads the contract's numbers to show the price before it is
    // paid; the server derives its own from the catalogue. Asserting them against
    // each other is what stops the two drifting silently.
    expect(probeCount('quick')).toBe(PROBE_BUDGET_COUNTS.quick);
    expect(probeCount('standard')).toBe(PROBE_BUDGET_COUNTS.standard);
    expect(probeCount('deep')).toBe(PROBE_BUDGET_COUNTS.deep);
  });

  it('spends more on the distribution probes as the budget grows', () => {
    const samples = (budget: 'quick' | 'standard' | 'deep'): number =>
      probesFor(budget)
        .filter((probe) => probe.reading === 'first-token-distribution')
        .reduce((total, probe) => total + probe.samples, 0);

    expect(samples('quick')).toBeLessThan(samples('standard'));
    expect(samples('standard')).toBeLessThan(samples('deep'));
  });

  it('declares a reading for every probe that the dispatcher handles', () => {
    const readings = new Set(
      (['quick', 'standard', 'deep'] as const).flatMap((budget) =>
        probesFor(budget).map((probe) => probe.reading),
      ),
    );
    expect([...readings].sort()).toEqual([
      'agreement',
      'first-token-distribution',
      'ladder',
      'parameter-acceptance',
      'refusal',
    ]);
  });

  it('gives every probe at least one prompt and one sample', () => {
    for (const budget of ['quick', 'standard', 'deep'] as const) {
      for (const probe of probesFor(budget)) {
        expect(probe.prompts.length).toBeGreaterThan(0);
        expect(probe.samples).toBeGreaterThan(0);
      }
    }
  });

  it('asks the distribution probes for several samples at a non-zero temperature', () => {
    // At zero the same prompt returns the same token every time, and the
    // measurement would be a single value compared against a single value.
    for (const probe of probesFor('standard').filter(
      (entry) => entry.reading === 'first-token-distribution',
    )) {
      expect(probe.samples).toBeGreaterThan(1);
      expect(probe.temperature).toBeGreaterThan(0);
    }
  });
});

/* ---- The table-driven readings ---- */

describe('reading a refusal', () => {
  it('recognises the openings a refusal actually takes', () => {
    expect(readsAsRefusal("I can't help with that.")).toBe(true);
    expect(readsAsRefusal('I cannot assist with this request.')).toBe(true);
    expect(readsAsRefusal('I must decline.')).toBe(true);
    expect(readsAsRefusal('Here is how you would do it:')).toBe(false);
  });

  it('only reads the opening, so a compliant answer that mentions refusing is not counted', () => {
    // "I can't speak for everyone, but here is how..." is an answer, and a search
    // over the whole text would score it as a refusal.
    const answer = `${'x'.repeat(300)} I cannot stress enough how simple this is.`;
    expect(readsAsRefusal(answer)).toBe(false);
  });
});

describe('reading the ladder', () => {
  it('accepts an answer that contains the expected value among prose', () => {
    expect(rungPassed('count-letters', '3')).toBe(true);
    expect(rungPassed('count-letters', "There are 3 r's in strawberry.")).toBe(true);
    expect(rungPassed('two-step-arithmetic', 'The answer is 38.')).toBe(true);
  });

  it('refuses an answer that names a different number', () => {
    expect(rungPassed('two-step-arithmetic', '39')).toBe(false);
    expect(rungPassed('count-letters', '4')).toBe(false);
  });

  it('reads the last number, so working-through is a pass and a hedge is not', () => {
    // A model that shows its working legitimately restates the question's
    // numbers, so looking for the expected value anywhere would pass almost
    // anything; and looking for it as the only number would fail every model
    // that works step by step. The last number is where an answer puts its
    // result — and a hedge that trails off on the wrong one is not a result.
    expect(rungPassed('three-step-arithmetic', '45 km and 30 km give 75 km/h.')).toBe(true);
    expect(rungPassed('two-step-arithmetic', 'It is 38 or 39.')).toBe(false);
  });

  it('refuses an empty answer', () => {
    expect(rungPassed('count-letters', '')).toBe(false);
    expect(rungPassed('nested-logic', '   ')).toBe(false);
  });

  it('reads the reverse and the transformation', () => {
    expect(rungPassed('reverse-word', 'esuohthgil')).toBe(true);
    expect(rungPassed('unseen-transformation', 'tjbrp')).toBe(true);
  });

  it('has a rung for every ladder entry', () => {
    // A rung with no prompt falls through to a generic sentence, which would make
    // the ladder measure something other than capability.
    for (const rung of LADDER) {
      expect(rungPassed(rung, 'nonsense')).toBe(false);
    }
  });
});

/* ---- The posterior ---- */

/**
 * A signal with the likelihoods a reading would produce.
 *
 * `measured` is separate from `usable` because the two answer different
 * questions — "did this produce an observation" and "was the observation
 * compared against something measured" — and only the second is what a band
 * above `insufficient` requires.
 */
function signal(usable: boolean, likelihoods: Record<string, number>, measured = false) {
  return {
    signal: {
      kind: 'api-surface' as const,
      label: 'x',
      passed: true,
      confidence: 0.5,
      detail: '',
      measurement: null,
      samples: 1,
    },
    likelihoods,
    usable,
    measured,
  };
}

describe('the posterior', () => {
  it('is flat when nothing had an opinion', () => {
    // The fresh-install state: every likelihood is neutral, so the posterior is
    // the prior and the band says there is not enough evidence.
    const posterior = accumulate({
      claimedFamily: 'anthropic',
      candidates: ['anthropic', 'openai'],
      signals: [signal(false, { anthropic: 1, openai: 1 })],
      probesSucceeded: 0,
      probesUsed: 0,
      measuredSignals: 0,
      hasModelBaseline: false,
    });
    expect(posterior.map((entry) => entry.score)).toEqual([0.5, 0.5]);
  });

  it('gives the claim no head start', () => {
    // ADR-0017's second rule: a claim is not evidence. A prior boost would put
    // exactly that back, and a reseller naming a family would begin ahead.
    const posterior = accumulate({
      claimedFamily: 'anthropic',
      candidates: ['anthropic', 'openai', 'google'],
      signals: [],
      probesSucceeded: 0,
      probesUsed: 0,
      measuredSignals: 0,
      hasModelBaseline: false,
    });
    expect(posterior.every((entry) => Math.abs(entry.score - 1 / 3) < 1e-9)).toBe(true);
  });

  it('multiplies every signal in and normalises', () => {
    const posterior = accumulate({
      claimedFamily: 'anthropic',
      candidates: ['anthropic', 'openai'],
      signals: [
        signal(true, { anthropic: 1, openai: 0.25 }),
        signal(true, { anthropic: 1, openai: 0.25 }),
      ],
      probesSucceeded: 10,
      probesUsed: 10,
      measuredSignals: 2,
      hasModelBaseline: false,
    });
    const mass = posterior.find((entry) => entry.claimed)?.score ?? 0;
    // 1 / (1 + 0.25²) = 0.941
    expect(mass).toBeCloseTo(0.941, 3);
    expect(posterior.reduce((sum, entry) => sum + entry.score, 0)).toBeCloseTo(1, 9);
  });

  it('marks the claimed family and only that one', () => {
    const posterior = accumulate({
      claimedFamily: 'google',
      candidates: ['google', 'openai'],
      signals: [],
      probesSucceeded: 0,
      probesUsed: 0,
      measuredSignals: 0,
      hasModelBaseline: false,
    });
    expect(posterior.filter((entry) => entry.claimed).map((entry) => entry.family)).toEqual([
      'google',
    ]);
  });
});

describe('the verdict band', () => {
  const posterior = (mass: number): readonly FamilyPosterior[] => [
    { family: 'anthropic', score: mass, claimed: true },
    { family: 'openai', score: 1 - mass, claimed: false },
  ];

  it('is insufficient below the usable-signal floor, whatever the numbers say', () => {
    // The fail-closed rule: one signal is a measurement, not an accumulation.
    expect(
      verdictOf(posterior(0.99), {
        claimedFamily: 'anthropic',
        probesSucceeded: 100,
        probesUsed: 100,
        hasModelBaseline: true,
        measuredSignals: 0,
      }),
    ).toBe('insufficient');
  });

  it('is insufficient below the success-rate floor', () => {
    // An endpoint answering four requests in five is failing, and a divergence
    // from the fifth is not representative of anything.
    expect(
      verdictOf(posterior(0.99), {
        claimedFamily: 'anthropic',
        probesSucceeded: 7,
        probesUsed: 10,
        hasModelBaseline: true,
        measuredSignals: 2,
      }),
    ).toBe('insufficient');
  });

  it('caps at family-only without a reference measured from the exact model', () => {
    // `match` is a claim about a build, and a family reference was never measured
    // from one.
    expect(
      verdictOf(posterior(0.95), {
        claimedFamily: 'anthropic',
        probesSucceeded: 100,
        probesUsed: 100,
        hasModelBaseline: false,
        measuredSignals: 2,
      }),
    ).toBe('family-only');
    expect(
      verdictOf(posterior(0.95), {
        claimedFamily: 'anthropic',
        probesSucceeded: 100,
        probesUsed: 100,
        hasModelBaseline: true,
        measuredSignals: 2,
      }),
    ).toBe('match');
  });

  it('reads the middle bands off the mass', () => {
    const base = {
      claimedFamily: 'anthropic',
      probesSucceeded: 100,
      probesUsed: 100,
      hasModelBaseline: true,
      measuredSignals: 2,
    };
    expect(verdictOf(posterior(0.5), base)).toBe('family-only');
    expect(verdictOf(posterior(0.3), base)).toBe('uncertain');
    expect(verdictOf(posterior(0.05), base)).toBe('mismatch');
  });

  it('says why, when the band is not obvious from the numbers', () => {
    const flat = posteriorOf({
      claimedFamily: 'anthropic',
      candidates: ['anthropic', 'openai'],
      signals: [signal(false, { anthropic: 1, openai: 1 })],
      probesSucceeded: 1,
      probesUsed: 1,
      measuredSignals: 0,
      hasModelBaseline: false,
    });
    expect(flat.verdict).toBe('insufficient');
    expect(flat.notes).toMatch(/Calibrate a reference/);

    const thin = posteriorOf({
      claimedFamily: 'anthropic',
      candidates: ['anthropic', 'openai'],
      signals: [signal(true, { anthropic: 1, openai: 1 }), signal(true, { anthropic: 1, openai: 1 })],
      probesSucceeded: 5,
      probesUsed: 10,
      measuredSignals: 2,
      hasModelBaseline: false,
    });
    expect(thin.verdict).toBe('insufficient');
    expect(thin.notes).toMatch(/50% of the 10 probes/);
  });

  it('explains the family-only ceiling', () => {
    const capped = posteriorOf({
      claimedFamily: 'anthropic',
      candidates: ['anthropic', 'openai'],
      signals: [
        signal(true, { anthropic: 1, openai: 0.25 }),
        signal(true, { anthropic: 1, openai: 0.25 }),
        signal(true, { anthropic: 1, openai: 0.25 }),
      ],
      probesSucceeded: 100,
      probesUsed: 100,
      measuredSignals: 2,
      hasModelBaseline: false,
    });
    expect(capped.verdict).toBe('family-only');
    expect(capped.notes).toMatch(/needs a reference measured from it/);
  });
});

/* ---- The dispatcher ---- */

describe('the signal dispatcher', () => {
  const context = {
    claimedFamily: 'anthropic',
    candidates: ['anthropic', 'openai'],
    baselinesFor: () => new Map(),
  };

  it('reports a distribution probe as unusable without enough samples', () => {
    // Said plainly rather than reporting a divergence between two lists of one
    // token each, which would read as confident evidence in the console.
    const probe = probesFor('quick').find((entry) => entry.id === 'dist-main');
    if (probe === undefined) throw new Error('the dist-main probe is missing');

    const result = signalFor(
      probe,
      [
        { probeId: probe.id, prompt: 'x', text: 'Paris', error: null, latencyMs: 1 },
        { probeId: probe.id, prompt: 'x', text: 'Paris', error: null, latencyMs: 1 },
      ],
      context,
    );

    expect(result.usable).toBe(false);
    expect(result.signal.measurement).toBeNull();
    expect(result.signal.detail).toMatch(/usable samples/);
  });

  it('reports a distribution probe as unusable with no reference to compare against', () => {
    const probe = probesFor('standard').find((entry) => entry.id === 'dist-main');
    if (probe === undefined) throw new Error('the dist-main probe is missing');

    const outcomes = Array.from({ length: 40 }, (_unused, index) => ({
      probeId: probe.id,
      prompt: 'x',
      text: index % 3 === 0 ? 'Paris' : 'London',
      error: null,
      latencyMs: 1,
    }));

    const result = signalFor(probe, outcomes, context);
    expect(result.usable).toBe(false);
    expect(result.signal.detail).toMatch(/No reference distribution for anthropic/);
  });

  it('computes a divergence once a reference exists', () => {
    const probe = probesFor('standard').find((entry) => entry.id === 'dist-main');
    if (probe === undefined) throw new Error('the dist-main probe is missing');

    const outcomes = Array.from({ length: 40 }, (_unused, index) => ({
      probeId: probe.id,
      prompt: 'x',
      text: index % 2 === 0 ? 'Paris' : 'London',
      error: null,
      latencyMs: 1,
    }));

    const result = signalFor(probe, outcomes, {
      ...context,
      baselinesFor: (subject) =>
        subject === 'anthropic'
          ? new Map([
              [
                probe.id,
                {
                  probeId: probe.id,
                  distribution: { paris: 0.5, london: 0.5 },
                  samples: 40,
                },
              ],
            ])
          : new Map(),
    });

    expect(result.usable).toBe(true);
    expect(result.signal.measurement).not.toBeNull();
    expect(result.signal.passed).toBe(true);
    // The reference is the sample's own shape, so the divergence is near zero.
    expect(result.signal.measurement ?? 1).toBeLessThan(JSD_TAU);
  });
});
