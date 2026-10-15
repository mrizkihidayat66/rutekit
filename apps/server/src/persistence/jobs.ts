import { asc, desc, eq, sql } from 'drizzle-orm';

import type { JobStatus } from '@contracts';

import type { Db } from './client.ts';
import { jobItems, jobs } from './schema.ts';

/**
 * Automation jobs (C7b, FR-5.x).
 *
 * The repository is deliberately mechanical: it stores what the manager decides
 * and never decides anything itself. The state machine, the counters and the
 * deadline live in `automation/jobs/`, because they are one thing and splitting
 * them across a repository would mean two places that know what a job's status
 * means.
 *
 * **Item writes are surgical.** The manager knows exactly which column changed —
 * an item started, an item ended, an attempt was spent — and writes that. A
 * whole-row update would be a read-modify-write on a row another item's write
 * could land beside, and a job with concurrency is exactly where that happens.
 *
 * `updateCounters` is the same discipline: the tallies are computed from the item
 * rows by SQL rather than carried in JavaScript, so a job's counters cannot drift
 * from its ledger even if a write is lost.
 */

export type JobRow = typeof jobs.$inferSelect;
export type JobInsert = typeof jobs.$inferInsert;
export type JobItemRow = typeof jobItems.$inferSelect;
export type JobItemInsert = typeof jobItems.$inferInsert;

/** The job columns the manager moves. Absent means leave alone. */
export interface JobPatch {
  readonly status?: JobStatus | undefined;
  readonly manualWorkerId?: string | null | undefined;
  readonly manualDeadlineAt?: string | null | undefined;
  readonly lastError?: string | null | undefined;
  readonly startedAt?: string | null | undefined;
  readonly finishedAt?: string | null | undefined;
}

export interface JobItemPatch {
  readonly status?: JobStatus | undefined;
  readonly attempts?: number | undefined;
  readonly lastError?: string | null | undefined;
  readonly accountLabel?: string | undefined;
  readonly startedAt?: string | null | undefined;
  readonly finishedAt?: string | null | undefined;
}

export interface JobsRepository {
  create(job: JobInsert, items: readonly JobItemInsert[]): void;
  listAll(): JobRow[];
  findById(id: string): JobRow | null;
  itemsOf(jobId: string): JobItemRow[];
  itemById(itemId: string): JobItemRow | null;
  /** The stored envelope, for the launcher. Never handed to a route. */
  payloadEnvelope(jobId: string): string | null;
  update(id: string, patch: JobPatch, updatedAt: string): void;
  updateItem(id: string, patch: JobItemPatch, updatedAt: string): void;
  /** Recompute the tallies from the item rows. Returns what it wrote. */
  refreshCounters(jobId: string, updatedAt: string): JobCounters;
  /**
   * Jobs a previous process left mid-flight.
   *
   * A job that was `running`, `needs_manual` or `queued` when the server died has
   * no worker behind it — no request outlives the process that sent it, and the
   * same is true of a subprocess. Recovery is what turns those rows into
   * something an operator can act on rather than spinners that never stop.
   */
  unfinished(): JobRow[];
  delete(id: string): void;
}

export interface JobCounters {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly needsManual: number;
}

export function createJobsRepository(db: Db): JobsRepository {
  return {
    create(job: JobInsert, items: readonly JobItemInsert[]): void {
      // One transaction, because a job whose items were never written is a job
      // with nothing to run — and the manager would have already reported its
      // total from the array it handed over.
      db.transaction((tx) => {
        tx.insert(jobs).values(job).run();
        for (const item of items) tx.insert(jobItems).values(item).run();
      });
    },

    listAll(): JobRow[] {
      // Newest first: a job list is read to find the run that just finished.
      return db.select().from(jobs).orderBy(desc(jobs.createdAt), desc(jobs.id)).all();
    },

    findById(id: string): JobRow | null {
      return db.select().from(jobs).where(eq(jobs.id, id)).get() ?? null;
    },

    itemsOf(jobId: string): JobItemRow[] {
      return db
        .select()
        .from(jobItems)
        .where(eq(jobItems.jobId, jobId))
        .orderBy(asc(jobItems.position), asc(jobItems.id))
        .all();
    },

    itemById(itemId: string): JobItemRow | null {
      return db.select().from(jobItems).where(eq(jobItems.id, itemId)).get() ?? null;
    },

    payloadEnvelope(jobId: string): string | null {
      const row = db
        .select({ envelope: jobs.payloadEnvelope })
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .get();
      return row?.envelope ?? null;
    },

    update(id: string, patch: JobPatch, updatedAt: string): void {
      const set: Partial<JobInsert> = { updatedAt };
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.manualWorkerId !== undefined) set.manualWorkerId = patch.manualWorkerId;
      if (patch.manualDeadlineAt !== undefined) set.manualDeadlineAt = patch.manualDeadlineAt;
      if (patch.lastError !== undefined) set.lastError = patch.lastError;
      if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
      if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
      db.update(jobs).set(set).where(eq(jobs.id, id)).run();
    },

    updateItem(id: string, patch: JobItemPatch, updatedAt: string): void {
      const set: Partial<JobItemInsert> = { updatedAt };
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.attempts !== undefined) set.attempts = patch.attempts;
      if (patch.lastError !== undefined) set.lastError = patch.lastError;
      if (patch.accountLabel !== undefined) set.accountLabel = patch.accountLabel;
      if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
      if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
      db.update(jobItems).set(set).where(eq(jobItems.id, id)).run();
    },

    refreshCounters(jobId: string, updatedAt: string): JobCounters {
      // Counted in SQL from the ledger rather than carried in JavaScript: a job
      // with concurrency has several writers, and a tally held in one of them
      // would drift from the rows it is supposed to describe.
      const row = db
        .select({
          total: sql<number>`count(*)`,
          succeeded: sql<number>`coalesce(sum(case when ${jobItems.status} = 'succeeded' then 1 else 0 end), 0)`,
          failed: sql<number>`coalesce(sum(case when ${jobItems.status} = 'failed' then 1 else 0 end), 0)`,
          needsManual: sql<number>`coalesce(sum(case when ${jobItems.status} = 'needs_manual' then 1 else 0 end), 0)`,
        })
        .from(jobItems)
        .where(eq(jobItems.jobId, jobId))
        .get();

      const counters: JobCounters = {
        total: row?.total ?? 0,
        succeeded: row?.succeeded ?? 0,
        failed: row?.failed ?? 0,
        needsManual: row?.needsManual ?? 0,
      };

      db.update(jobs)
        .set({
          total: counters.total,
          succeeded: counters.succeeded,
          failed: counters.failed,
          needsManual: counters.needsManual,
          updatedAt,
        })
        .where(eq(jobs.id, jobId))
        .run();

      return counters;
    },

    unfinished(): JobRow[] {
      return db
        .select()
        .from(jobs)
        .where(
          sql`${jobs.status} in ('queued', 'running', 'needs_manual', 'paused')`,
        )
        .all();
    },

    delete(id: string): void {
      db.transaction((tx) => {
        tx.delete(jobItems).where(eq(jobItems.jobId, id)).run();
        tx.delete(jobs).where(eq(jobs.id, id)).run();
      });
    },
  };
}
