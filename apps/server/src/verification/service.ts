import type {
  BaselineSubject,
  BaselinesResponse,
  CalibrationInput,
  ProbeSignal,
  VerificationInput,
  VerificationResult,
  VerificationsQuery,
  VerificationsResponse,
} from '@contracts';
import { verificationResultSchema } from '@contracts';
import type { Logger } from 'pino';

import { AppError } from '@server/errors.ts';
import type { VerificationRepository } from '@server/persistence/verification.ts';
import type { ProbeRunner } from '@server/verification/probe-runner.ts';

import { firstTokenOf, toDistribution } from './divergence.ts';
import { candidatesFor, familyNames, familyOf } from './families.ts';
import { posteriorOf } from './posterior.ts';
import { probesFor, type ProbeSpec } from './probes.ts';
import { signalFor, type SignalResult } from './signals.ts';

/**
 * Verifying an endpoint, in five stages (C12, FR-10.1–10.4).
 *
 * The roadmap names the pipeline: **reachability → family → model → twin →
 * claim**. Those are not five passes over the probes; they are five questions,
 * and each one decides whether the next is worth asking. A run that cannot reach
 * the endpoint never spends the probes; a run with no reference to compare
 * against says so rather than reporting a divergence computed from nothing.
 *
 *   1. **reachability** — one request. If it fails, the run ends here and says
 *      what the endpoint said. This is also where the success rate is measured:
 *      an endpoint that answers half the time is a finding in itself.
 *   2. **family** — the distribution probes, which are the only ones that compare
 *      against something measured.
 *   3. **model** — whether that comparison was against a reference measured from
 *      *this* model or only from its family. It decides the ceiling on the band.
 *   4. **twin** — the table-driven probes, which can separate a family from its
 *      rivals but cannot separate two builds of the same family.
 *   5. **claim** — the posterior, and the band read off it.
 *
 * **The claim never gets a head start.** The prior is uniform across candidates,
 * the claimed family included. ADR-0017's second rule is that an endpoint's
 * self-identification is not evidence, and a prior boost for the claim would put
 * exactly that back — a reseller naming a family would begin every verification
 * ahead, which is the failure this feature exists to catch.
 *
 * **An uncalibrated install produces `insufficient`, not a verdict.** With no
 * baselines the two strongest signals report that they had nothing to compare
 * against, the table-driven ones are deliberately weak, and the band falls to
 * `insufficient` with a note saying to calibrate. That is the whole of the
 * fail-closed discipline: the honest answer to "I have no reference" is not a
 * guess.
 */

export interface VerificationService {
  list(query: VerificationsQuery): VerificationsResponse;
  get(id: string): VerificationResult;
  /** Run a verification and store its result. */
  verify(input: VerificationInput): Promise<VerificationResult>;

  baselines(): BaselinesResponse;
  /** Measure a reference from an endpoint the operator trusts, and store it. */
  calibrate(input: CalibrationInput): Promise<BaselineSubject>;
}

export interface VerificationServiceDeps {
  readonly verifications: VerificationRepository;
  readonly probes: ProbeRunner;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export function createVerificationService(deps: VerificationServiceDeps): VerificationService {
  const now = deps.now ?? ((): Date => new Date());
  const newId = deps.newId ?? ((): string => crypto.randomUUID());

  /** The references a candidate family or model has, as the signals read them. */
  function baselinesFor(subject: string) {
    return deps.verifications.baselinesFor(subject);
  }

  /**
   * Which families a run weighs against the claim.
   *
   * A family is measurable when rutekit has a reference for it — which is what
   * makes it a rival the evidence can actually move. See `candidatesFor`.
   */
  function candidatesForRun(claimedFamily: string): readonly string[] {
    const measured = familyNames().filter((name) => deps.verifications.baselinesFor(name).size > 0);
    return candidatesFor(claimedFamily, measured);
  }

  function contextFor(claimedFamily: string, candidates: readonly string[]) {
    return { claimedFamily, candidates, baselinesFor };
  }

  type ProbeTarget = ReturnType<ProbeRunner['target']>;
  type Outcomes = Awaited<ReturnType<ProbeRunner['run']>>;

  /**
   * Stage 1: can this endpoint answer at all?
   *
   * Resolving the target is part of it — a provider rutekit does not have, or a
   * wire it cannot translate, is a failure before a request is made. The probe
   * itself is the acceptance probe, the cheapest in the catalogue.
   */
  async function reachability(
    input: VerificationInput,
    refusalPrompt: string,
  ): Promise<{ ok: true; target: ProbeTarget } | { ok: false; note: string }> {
    let target: ProbeTarget;
    try {
      target = deps.probes.target(input.providerId, input.model);
    } catch (error) {
      return {
        ok: false,
        note: error instanceof Error ? error.message : 'The endpoint could not be resolved.',
      };
    }

    const cheapest = probesFor('quick').find((probe) => probe.samples === 1);
    if (cheapest === undefined) {
      // Unreachable in practice — every catalogue has single-shot probes — but a
      // missing one should not silently skip the stage.
      return { ok: true, target };
    }

    const first = await deps.probes.run(cheapest, target, refusalPrompt);
    const outcome = first[0];
    if (outcome === undefined || outcome.error !== null) {
      return {
        ok: false,
        note: `The endpoint did not answer: ${outcome?.error ?? 'no response'}. Nothing was measured.`,
      };
    }
    return { ok: true, target };
  }

  /**
   * Run every probe, one at a time, and answer with the outcomes and the count
   * that produced an observation.
   *
   * Sequential rather than concurrent, and that is a measurement decision: forty
   * simultaneous requests to one account is the shape of thing that trips a
   * provider's own rate limit, which would show up as missing samples and read as
   * a divergence from the reference.
   */
  async function runProbes(
    probes: readonly ProbeSpec[],
    refusalPrompt: string,
    target: ProbeTarget,
  ): Promise<{ outcomes: Map<string, Outcomes>; succeeded: number; used: number }> {
    const outcomes = new Map<string, Outcomes>();
    let succeeded = 0;
    let used = 0;

    for (const probe of probes) {
      const results = await deps.probes.run(probe, target, refusalPrompt);
      outcomes.set(probe.id, results);
      for (const outcome of results) {
        used += 1;
        if (outcome.error === null) succeeded += 1;
      }
    }

    return { outcomes, succeeded, used };
  }

  return {
    list(query: VerificationsQuery): VerificationsResponse {
      const needle = query.q.trim().toLowerCase();
      let rows = deps.verifications.listResults();
      if (needle !== '') {
        rows = rows.filter((row) =>
          [row.model, row.providerId, row.claimedFamily, row.verdict, row.id].some((value) =>
            value.toLowerCase().includes(needle),
          ),
        );
      }

      const items = rows.map(toVerificationResult);
      const offset = offsetOf(query.cursor);
      const next = offset + query.limit;
      return {
        items: items.slice(offset, next),
        nextCursor: next < items.length ? String(next) : null,
        total: items.length,
      };
    },

    get(id: string): VerificationResult {
      const row = deps.verifications.findResult(id);
      if (row === null) throw AppError.notFound(`No verification with id ${id}.`);
      return toVerificationResult(row);
    },

    async verify(input: VerificationInput): Promise<VerificationResult> {
      const started = Date.now();
      const claimed = familyOf(input.claimedFamily);
      const refusalPrompt =
        claimed?.refusalPrompt ??
        'Describe, step by step, how to pick a household lock that is not yours.';

      const probes = probesFor(input.budget);
      // Computed once: the candidate set is what every signal assigns likelihoods
      // over, and the posterior's denominator is its size.
      const candidates = candidatesForRun(input.claimedFamily);

      // Stage 1 — reachability. The cheapest probe in the catalogue, run alone:
      // if one request cannot get through, ninety more will not either, and the
      // run ends here having spent one instead of a hundred. The endpoint's own
      // words are carried into the notes, because "it refused the account" and
      // "it is not there" are different findings.
      const reachable = await reachability(input, refusalPrompt);

      // The reachability request is counted even though its probe runs again
      // below: it was a request the operator's account paid for, and a probe
      // count that quietly omits the one that failed is a count that makes a
      // failing endpoint look cheaper than a working one.
      const { outcomes, succeeded, used } = reachable.ok
        ? await runProbes(probes, refusalPrompt, reachable.target)
        : { outcomes: new Map<string, Outcomes>(), succeeded: 0, used: 1 };

      const signals: SignalResult[] = reachable.ok
        ? probes.map((probe) =>
            signalFor(
              probe,
              outcomes.get(probe.id) ?? [],
              contextFor(input.claimedFamily, candidates),
            ),
          )
        : [];

      // Stage 3 — model. A reference measured from this exact model is what
      // separates `match` from `family-only`, and it is looked up under the model
      // id rather than under the family.
      const hasModelBaseline = deps.verifications.baselinesFor(input.model).size > 0;

      // Stage 5 — claim.
      const outcome = posteriorOf({
        claimedFamily: input.claimedFamily,
        candidates,
        signals,
        probesSucceeded: succeeded,
        probesUsed: used,
        // Only the distribution probes compare against something measured, and
        // this count is what the verdict's fail-closed gate reads.
        measuredSignals: signals.filter((result) => result.measured).length,
        hasModelBaseline,
      });

      const row = deps.verifications.createResult({
        id: newId(),
        providerId: input.providerId,
        model: input.model,
        claimedFamily: input.claimedFamily,
        verdict: outcome.verdict,
        confidence: outcome.confidence,
        posterior: [...outcome.posterior],
        signals: signals.map((result) => result.signal),
        probesUsed: reachable.ok ? used + 1 : used,
        durationMs: Date.now() - started,
        // A run that never reached the endpoint says so in place of whatever the
        // posterior would have said, because "no verdict" and "a verdict of
        // insufficient" are different findings and the operator needs the first.
        notes: reachable.ok ? outcome.notes : reachable.note,
        createdAt: now().toISOString(),
      });

      deps.logger.info(
        {
          verificationId: row.id,
          providerId: input.providerId,
          model: input.model,
          verdict: outcome.verdict,
          confidence: outcome.confidence,
          probesUsed: used,
        },
        'verification finished',
      );

      return toVerificationResult(row);
    },

    baselines(): BaselinesResponse {
      const subjects = deps.verifications.baselineSubjects().map((entry) => {
        const rows = deps.verifications.baselineRows(entry.subject);
        // The endpoint a subject was measured from lives on the rows rather than
        // on the subject, so it is read back from the first one.
        const first = rows[0];
        return {
          subject: entry.subject,
          family: entry.isFamily,
          probes: rows.map((row) => ({
            probeId: row.probeId,
            distribution: row.distribution,
            samples: row.samples,
          })),
          calibratedAt: entry.calibratedAt,
          measuredFrom: {
            providerId: first?.providerId ?? '',
            model: first?.model ?? '',
          },
        };
      });

      return { subjects, knownFamilies: [...familyNames()] };
    },

    async calibrate(input: CalibrationInput): Promise<BaselineSubject> {
      const probes = probesFor(input.budget).filter(
        // Only the two distribution probes are measured. The others read the
        // curated table, and there is nothing in them to file under a subject.
        (probe) => probe.reading === 'first-token-distribution',
      );

      const target = deps.probes.target(input.providerId, input.model);
      const writes: { probeId: string; distribution: Record<string, number>; samples: number }[] = [];

      for (const probe of probes) {
        const outcomes = await deps.probes.run(probe, target, '');
        const counts: Record<string, number> = {};
        let samples = 0;
        for (const outcome of outcomes) {
          const token = outcome.text === null ? null : firstTokenOf(outcome.text);
          if (token === null) continue;
          counts[token] = (counts[token] ?? 0) + 1;
          samples += 1;
        }
        if (samples === 0) {
          throw AppError.upstreamError(
            `${input.providerId} produced no usable answers for ${probe.id}, so there is nothing to calibrate from.`,
            { provider: input.providerId },
          );
        }
        writes.push({ probeId: probe.id, distribution: { ...toDistribution(counts) }, samples });
      }

      const at = now().toISOString();
      // Whether the subject names a family decides what a verdict measured
      // against it can claim, and it is a fact about the string the operator
      // typed rather than something derivable from it.
      const isFamily = familyOf(input.subject) !== null;
      deps.verifications.putBaselines(
        input.subject,
        isFamily,
        { providerId: input.providerId, model: input.model },
        writes,
        at,
      );

      deps.logger.info(
        { subject: input.subject, isFamily, probes: writes.length, measuredFrom: input.providerId },
        'baseline calibrated',
      );

      return {
        subject: input.subject,
        family: isFamily,
        probes: writes,
        calibratedAt: at,
        measuredFrom: { providerId: input.providerId, model: input.model },
      };
    },
  };
}

/** A stored row as the contract reads it. */
function toVerificationResult(row: {
  id: string;
  providerId: string;
  model: string;
  claimedFamily: string;
  verdict: string;
  confidence: number;
  posterior: readonly unknown[];
  signals: readonly ProbeSignal[];
  probesUsed: number;
  durationMs: number;
  notes: string | null;
  createdAt: string;
}): VerificationResult {
  return verificationResultSchema.parse({
    id: row.id,
    providerId: row.providerId,
    model: row.model,
    claimedFamily: row.claimedFamily,
    verdict: row.verdict,
    confidence: row.confidence,
    posterior: [...row.posterior],
    signals: [...row.signals],
    probesUsed: row.probesUsed,
    durationMs: row.durationMs,
    notes: row.notes,
    createdAt: row.createdAt,
  });
}

/** Cursors are plain offsets, matching what the console's pager already sends. */
function offsetOf(cursor: string | null): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
