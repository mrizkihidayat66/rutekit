import type { Migration } from './types.ts';

/**
 * What the Token Saver removed, per turn (C14, FR-1.2 / A3).
 *
 * The Token Saver's own settings page has reported savings since PHASE B — the
 * console's fixture draws the per-stage bars and the trend line — but the server
 * never recorded any of it. `packages/compression` has produced a `StageReport`
 * per stage since the pipeline was written; the call site took `.request` and let
 * the rest fall on the floor. This column is where the rest goes.
 *
 * **One nullable JSON column rather than a table of its own**, and the reason is
 * the invariant `telemetry/recorder.ts` is built on: a turn is written **once**,
 * when it ends. A child table would be N rows written at that same moment, and
 * the two could then disagree — a turn with three stage rows and no parent, or a
 * parent whose stages were half-written by a crash. One column cannot be half a
 * turn.
 *
 * It also means retention needs no new code: `deleteOlderThan` removes a `requests`
 * row and the savings go with it, where a child table would need a cascade or a
 * second sweep of its own.
 *
 * **Null means the pipeline did not run**, which is a different fact from "it ran
 * and saved nothing". A turn that never reached compression — a refusal, a 404, a
 * request with the Token Saver switched off — has no savings to report and must
 * not be counted in `requestsProcessed`. An empty report would be indistinguishable
 * from a pipeline that ran over a body it could not shrink, and those are two
 * different things for an operator deciding whether the feature is earning its
 * keep.
 *
 * The shape inside is `{ tokensIn, tokensOut, tokensSaved, stages: [...] }`, where
 * each stage is the pipeline's own `StageReport`. The per-stage breakdown is read
 * back with SQLite's `json_each`, which is why the column is JSON and not a blob:
 * the aggregate the page needs is a `group by` over the array, and it stays one.
 */
export const migration0016: Migration = {
  id: 16,
  name: 'token-saver-savings',
  statements: [
    // Nullable, and with no default: "the pipeline did not run" is the honest
    // value for every row that already exists, and backfilling a zero report
    // would claim the Token Saver ran over traffic it never saw.
    `alter table requests add column token_saver_savings text;`,
  ],
};
