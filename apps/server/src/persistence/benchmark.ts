import { asc, desc, eq } from 'drizzle-orm';

import type { Db } from './client.ts';
import { benchmarkResults, benchmarkRuns } from './schema.ts';

/**
 * Benchmark runs and their cells (C11, FR-9.x).
 *
 * Two lifetimes again, and the split is worth stating: a run is created once and
 * then only moves through its statuses, while its cells arrive one at a time
 * while it runs. So a run is updated in place and its cells are appended —
 * `appendResults` is a batch insert because promptfoo reports its whole matrix at
 * the end, and a hundred and twenty single-row writes in a loop is a hundred and
 * twenty transactions for one answer.
 *
 * **The cells are written once.** A run that is re-read after finishing does not
 * get its cells rewritten: promptfoo's output is the record, and rewriting it
 * would let a second reading of the same file change what the run says. That is
 * why there is no `updateResult` — a cell that could not be parsed is a cell
 * stored with the reason.
 */

export type BenchmarkRunRow = typeof benchmarkRuns.$inferSelect;
export type BenchmarkRunInsert = typeof benchmarkRuns.$inferInsert;
export type BenchmarkResultRow = typeof benchmarkResults.$inferSelect;
export type BenchmarkResultInsert = typeof benchmarkResults.$inferInsert;

/** The fields a run moves through while it works. */
export interface BenchmarkRunPatch {
  readonly status?: string | undefined;
  readonly error?: string | null | undefined;
  readonly workspaceDir?: string | null | undefined;
  readonly startedAt?: string | null | undefined;
  readonly finishedAt?: string | null | undefined;
}

export interface BenchmarkRepository {
  createRun(record: BenchmarkRunInsert): BenchmarkRunRow;
  findRun(id: string): BenchmarkRunRow | null;
  listRuns(): BenchmarkRunRow[];
  updateRun(id: string, patch: BenchmarkRunPatch): void;
  /** How many cells each run holds, keyed by run id — for the list. */
  resultCounts(): ReadonlyMap<string, number>;

  resultsOf(runId: string): BenchmarkResultRow[];
  /** Append a whole matrix in one transaction. */
  appendResults(records: readonly BenchmarkResultInsert[]): void;
  /**
   * Mark every run still live as failed, and answer with the rows as they now
   * stand. Called once at boot: the child process that was running them is gone.
   */
  interruptLive(reason: string, at: string): BenchmarkRunRow[];
}

export interface BenchmarkRepositoryDeps {
  readonly db: Db;
}

/** The states a run has not finished in. */
export const LIVE_RUN_STATUSES = ['queued', 'running'] as const;

export function createBenchmarkRepository(deps: BenchmarkRepositoryDeps): BenchmarkRepository {
  return {
    createRun(record: BenchmarkRunInsert): BenchmarkRunRow {
      const row = deps.db.insert(benchmarkRuns).values(record).returning().get();
      if (row === undefined) throw new Error('the inserted benchmark run could not be read back');
      return row;
    },

    findRun(id: string): BenchmarkRunRow | null {
      return deps.db.select().from(benchmarkRuns).where(eq(benchmarkRuns.id, id)).get() ?? null;
    },

    listRuns(): BenchmarkRunRow[] {
      // Newest first: a run list is read to find the one just started.
      return deps.db
        .select()
        .from(benchmarkRuns)
        .orderBy(desc(benchmarkRuns.createdAt), asc(benchmarkRuns.id))
        .all();
    },

    updateRun(id: string, patch: BenchmarkRunPatch): void {
      const set: Partial<BenchmarkRunInsert> = {};
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.error !== undefined) set.error = patch.error;
      if (patch.workspaceDir !== undefined) set.workspaceDir = patch.workspaceDir;
      if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
      if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
      if (Object.keys(set).length === 0) return;
      deps.db.update(benchmarkRuns).set(set).where(eq(benchmarkRuns.id, id)).run();
    },

    resultCounts(): ReadonlyMap<string, number> {
      const rows = deps.db
        .select({ runId: benchmarkResults.runId, id: benchmarkResults.id })
        .from(benchmarkResults)
        .all();
      const counts = new Map<string, number>();
      for (const row of rows) counts.set(row.runId, (counts.get(row.runId) ?? 0) + 1);
      return counts;
    },

    resultsOf(runId: string): BenchmarkResultRow[] {
      return deps.db
        .select()
        .from(benchmarkResults)
        .where(eq(benchmarkResults.runId, runId))
        .orderBy(asc(benchmarkResults.position), asc(benchmarkResults.id))
        .all();
    },

    appendResults(records: readonly BenchmarkResultInsert[]): void {
      if (records.length === 0) return;
      // One transaction for the whole matrix: a half-written result set is a
      // table that claims a run finished while some of its cells are missing,
      // and nothing downstream could tell which.
      deps.db.transaction((tx) => {
        for (const record of records) tx.insert(benchmarkResults).values(record).run();
      });
    },

    interruptLive(reason: string, at: string): BenchmarkRunRow[] {
      const moved: BenchmarkRunRow[] = [];
      for (const status of LIVE_RUN_STATUSES) {
        moved.push(
          ...deps.db
            .update(benchmarkRuns)
            .set({ status: 'failed', error: reason, finishedAt: at })
            .where(eq(benchmarkRuns.status, status))
            .returning()
            .all(),
        );
      }
      return moved;
    },
  };
}
