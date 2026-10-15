import {
  COMPRESSION_STAGE_IDS,
  type CompressionStageId,
  type TimeWindow,
  type TokenSaverSavings,
  type TokenSaverStageSavings,
} from '@contracts';
import { bytesToTokens } from '@compression';
import { z } from 'zod';

import type { CompressionReport } from '@server/providers/model-call.ts';
import type { RequestsRepository, StageSavingsRow } from '@server/persistence/requests.ts';

import { bucketStarts, windowRange } from './window.ts';

/**
 * What the Token Saver removed, and what the page reads (C14, FR-1.2 / A3).
 *
 * Two halves that look like one file because they are one subject. The first is
 * the **stored document** — what a finished turn writes down about its own
 * compression — and the second is the **read model** that aggregates those
 * documents into the `TokenSaverSavings` the console renders.
 *
 * **The stored shape is not the contract's shape.** `tokenSaverSavingsSchema` in
 * `packages/contracts` is a *window aggregate*: totals, a per-stage breakdown, a
 * trend. A single turn has none of those things — it has two sizes and the
 * stages' reports. Storing the aggregate per row and summing it would be storing
 * a number that is only meaningful once, and the ratio would then be an average
 * of ratios rather than a ratio of totals, which is a different and wrong figure.
 *
 * **Only four fields per stage are kept.** The pipeline's own `StageReport` also
 * carries `failed`, and it is dropped here on purpose: a stage that threw keeps
 * its input verbatim, so it reports `bytesIn === bytesOut` and saves nothing. The
 * failure is therefore already visible as "this stage saved zero", and a flag
 * nobody can act on differently is a field that only exists to drift.
 */

/**
 * One turn's savings, as stored.
 *
 * Validated on the way back out rather than trusted, for the same reason every
 * other record in this codebase is: a row hand-edited into something else must
 * degrade rather than throw. It is read with `safeParse`, and a document that
 * does not fit is skipped.
 */
export const storedSavingsSchema = z.object({
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  tokensSaved: z.number().int().nonnegative(),
  stages: z.array(
    z.object({
      stageId: z.string(),
      bytesIn: z.number().int().nonnegative(),
      bytesOut: z.number().int().nonnegative(),
      tokensSaved: z.number().int().nonnegative(),
    }),
  ),
});

export type StoredSavings = z.infer<typeof storedSavingsSchema>;

/**
 * A finished turn's compression, as the document to store — or null.
 *
 * **Null when the pipeline did not run**, which is the whole reason this returns
 * an option rather than an empty document. A turn with the Token Saver switched
 * off has nothing to report, and reporting `tokensSaved: 0` would make it
 * indistinguishable from a turn the pipeline ran over and could not shrink — and
 * `requestsProcessed` would then count traffic the feature never touched.
 *
 * `tokensOut` is derived as `tokensIn - tokensSaved` rather than converted from
 * the outbound byte count, and that is deliberate: the per-stage figures are
 * floored, so a sum of them can sit a token or two below the difference between
 * the two sizes. Deriving the outbound figure keeps the headline arithmetic
 * self-consistent — the bars add up to the total — which is what an operator
 * checks a savings chart for.
 */
export function storedSavingsOf(report: CompressionReport): StoredSavings | null {
  if (report.stages.length === 0) return null;

  const tokensIn = bytesToTokens(report.bytesIn);
  const tokensSaved = report.stages.reduce((total, stage) => total + stage.tokensSaved, 0);

  return {
    tokensIn,
    tokensOut: Math.max(0, tokensIn - tokensSaved),
    tokensSaved,
    stages: report.stages.map((stage) => ({
      stageId: stage.stageId,
      bytesIn: stage.bytesIn,
      bytesOut: stage.bytesOut,
      tokensSaved: stage.tokensSaved,
    })),
  };
}

/** Serialise for the column, or null. Kept here so the writer holds no shape. */
export function encodeSavings(report: CompressionReport): string | null {
  const stored = storedSavingsOf(report);
  return stored === null ? null : JSON.stringify(stored);
}

export interface SavingsService {
  savings(window: TimeWindow): TokenSaverSavings;
}

export interface SavingsServiceDeps {
  readonly requests: RequestsRepository;
  readonly now?: () => Date;
}

export function createSavingsService(deps: SavingsServiceDeps): SavingsService {
  const now = deps.now ?? ((): Date => new Date());

  return {
    savings(window: TimeWindow): TokenSaverSavings {
      const range = windowRange(window, now());

      const totals = deps.requests.savingsTotals(range.from, range.to);
      const perStage = deps.requests.savingsByStage(range.from, range.to);
      const points = deps.requests.savingsSeries(range.from, range.to, range.bucketSeconds);
      const byBucket = new Map(points.map((point) => [point.bucket, point.tokensSaved]));

      // A fresh instance — or one where the Token Saver is off — has no savings,
      // and a ratio of `0 / 0` is not zero, it is undefined. Reporting 0 would say
      // "the Token Saver is running and saving nothing", which is a different and
      // discouraging claim about a feature that has simply not been used yet.
      const ratio = totals.tokensIn === 0 ? 0 : totals.tokensSaved / totals.tokensIn;

      return {
        window,
        requestsProcessed: totals.requests,
        tokensIn: totals.tokensIn,
        tokensOut: totals.tokensOut,
        tokensSaved: totals.tokensSaved,
        ratio: Math.min(1, Math.max(0, ratio)),
        perStage: orderStages(perStage),
        // The gaps put back, from the same grid the usage chart uses — see
        // `bucketStarts` for why a missing bucket must not be left missing.
        series: bucketStarts(range).map((date) => ({
          date,
          tokensSaved: byBucket.get(date) ?? 0,
        })),
      };
    },
  };
}

/**
 * The stages in the pipeline's own order.
 *
 * SQL's `group by` returns rows in whatever order it likes, and the page draws
 * them in the order it is handed. The pipeline's order is the order the request
 * passes through them, which is the order a reader expects the bars to be in —
 * so it is restored here rather than left to the database.
 *
 * A row naming a stage the contract does not declare is **dropped**, and that is
 * a deliberate choice between two imperfect ones. The alternative — narrowing it
 * to some known id — would attribute real savings to a stage that did not make
 * them, which is a chart that lies. Dropping makes the bars sum to less than the
 * headline instead, which is visible and recoverable. It cannot happen from
 * rutekit's own writes in any case: the stored document is built from
 * `StageReport`, whose `stageId` is the same enum.
 */
function isStageId(value: string): value is CompressionStageId {
  return COMPRESSION_STAGE_IDS.some((id) => id === value);
}

/** A stage row whose id the contract can carry. */
type KnownStageRow = StageSavingsRow & { readonly stageId: CompressionStageId };

function orderStages(rows: readonly StageSavingsRow[]): TokenSaverStageSavings[] {
  const rank = new Map<string, number>(
    COMPRESSION_STAGE_IDS.map((id, index) => [id, index] as const),
  );

  return rows
    .filter((row): row is KnownStageRow => isStageId(row.stageId))
    .sort((left, right) => (rank.get(left.stageId) ?? 0) - (rank.get(right.stageId) ?? 0))
    .map((row) => ({
      stageId: row.stageId,
      bytesIn: row.bytesIn,
      bytesOut: row.bytesOut,
      tokensSaved: row.tokensSaved,
    }));
}
