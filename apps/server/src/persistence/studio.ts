import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import type { Db } from './client.ts';
import { studioAssets, studioGenerations } from './schema.ts';

/**
 * Studio generations and assets (C10, FR-8.x).
 *
 * Two repositories in one file because they are two halves of one feature and
 * neither is large: the queue's ledger and the gallery's index.
 *
 * **`takeNext` is the queue's own claim, and it is a transaction.** A job that is
 * queued is claimed by moving it to `executing` and stamping `started_at`, and
 * the read and the write have to be one step: two runners asking at the same
 * instant would otherwise both be handed the same row, and the render would run
 * twice for one prompt. The `where status = 'queued'` is what makes the second
 * claim a no-op rather than a duplicate.
 *
 * **A row written by a process that died is recovered, not resumed.** Nothing
 * here tries to reattach to a render that was in flight when the server stopped:
 * the driver that owned it is gone, and its handle is meaningless to a new
 * process. `interruptLive` marks those rows failed with a reason an operator can
 * read, which is the same choice C7b made for a job found `running` after a
 * restart.
 */

export type StudioGenerationRow = typeof studioGenerations.$inferSelect;
export type StudioGenerationInsert = typeof studioGenerations.$inferInsert;
export type StudioAssetRow = typeof studioAssets.$inferSelect;
export type StudioAssetInsert = typeof studioAssets.$inferInsert;

/** The fields a running job reports back as it moves. */
export interface GenerationProgress {
  readonly status?: string | undefined;
  readonly progress?: number | null | undefined;
  readonly stage?: string | null | undefined;
}

export interface StudioRepository {
  /* ---- generations ---- */

  createGeneration(record: StudioGenerationInsert): StudioGenerationRow;
  /** Many at once, for a batch. All or nothing: a batch that half-exists is a queue that lies. */
  createGenerations(records: readonly StudioGenerationInsert[]): StudioGenerationRow[];
  findGeneration(id: string): StudioGenerationRow | null;
  listGenerations(): StudioGenerationRow[];

  /**
   * Claim the oldest queued job, or null when there is nothing waiting.
   *
   * Read and claim in one transaction: two runners asking at the same moment
   * must not both be handed the same row.
   */
  takeNext(): StudioGenerationRow | null;

  /** Record a job's movement. Only the fields given are written. */
  updateGeneration(id: string, patch: GenerationProgress & {
    readonly assetId?: string | null | undefined;
    readonly error?: string | null | undefined;
    readonly startedAt?: string | null | undefined;
    readonly finishedAt?: string | null | undefined;
  }): void;

  /**
   * Mark every still-live job failed, with the reason given, and answer with the
   * rows as they now stand.
   *
   * Called once at boot. Nothing reattaches to a render that was in flight when
   * the process stopped: the driver that owned it is gone and its handle means
   * nothing to a new process. The rows come back rather than a count, because the
   * caller publishes them — a client watching the queue would otherwise keep
   * showing those jobs as still working.
   */
  interruptLive(reason: string, at: string): StudioGenerationRow[];

  /* ---- assets ---- */

  createAsset(record: StudioAssetInsert): StudioAssetRow;
  findAsset(id: string): StudioAssetRow | null;
  listAssets(): StudioAssetRow[];
  setFavorite(id: string, favorite: boolean): void;
  deleteAsset(id: string): void;
}

export interface StudioRepositoryDeps {
  readonly db: Db;
  readonly now?: () => Date;
}

/** The states a job has not finished in. */
export const LIVE_GENERATION_STATUSES = ['queued', 'executing', 'progress'] as const;

export function createStudioRepository(deps: StudioRepositoryDeps): StudioRepository {
  const now = deps.now ?? ((): Date => new Date());

  return {
    createGeneration(record: StudioGenerationInsert): StudioGenerationRow {
      const row = deps.db.insert(studioGenerations).values(record).returning().get();
      if (row === undefined) throw new Error('the inserted generation could not be read back');
      return row;
    },

    createGenerations(records: readonly StudioGenerationInsert[]): StudioGenerationRow[] {
      if (records.length === 0) return [];
      return deps.db.transaction((tx) =>
        records.map((record) => {
          const row = tx.insert(studioGenerations).values(record).returning().get();
          if (row === undefined) throw new Error('the inserted generation could not be read back');
          return row;
        }),
      );
    },

    findGeneration(id: string): StudioGenerationRow | null {
      return (
        deps.db.select().from(studioGenerations).where(eq(studioGenerations.id, id)).get() ?? null
      );
    },

    listGenerations(): StudioGenerationRow[] {
      // Newest first: the queue is read to find what was just asked for.
      return deps.db
        .select()
        .from(studioGenerations)
        .orderBy(desc(studioGenerations.createdAt), asc(studioGenerations.id))
        .all();
    },

    takeNext(): StudioGenerationRow | null {
      return deps.db.transaction((tx) => {
        const candidate = tx
          .select()
          .from(studioGenerations)
          .where(eq(studioGenerations.status, 'queued'))
          // Oldest first: a queue that runs newest-first starves the job that has
          // been waiting longest, which is the opposite of what a queue is for.
          //
          // `rowid` breaks the tie, and it is load-bearing rather than cosmetic:
          // a batch is written in one transaction with one timestamp, so every
          // job in it shares a `created_at` to the millisecond — and without a
          // second key the order would fall to whatever the query planner felt
          // like, which for a batch is a coin toss per read. SQLite's rowid is
          // insertion order, which is exactly "the order they were queued".
          .orderBy(asc(studioGenerations.createdAt), sql`rowid`)
          .limit(1)
          .get();
        if (candidate === undefined) return null;

        // The status is part of the predicate, so a row another runner claimed
        // between the read and this write is not claimed twice. In one
        // transaction the race cannot happen at all, but the guard is what makes
        // that a fact about the statement rather than about the isolation level.
        const claimed = tx
          .update(studioGenerations)
          .set({ status: 'executing', startedAt: now().toISOString() })
          .where(
            and(eq(studioGenerations.id, candidate.id), eq(studioGenerations.status, 'queued')),
          )
          .returning()
          .get();
        return claimed ?? null;
      });
    },

    updateGeneration(id, patch): void {
      const set: Partial<StudioGenerationInsert> = {};
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.progress !== undefined) set.progress = patch.progress;
      if (patch.stage !== undefined) set.stage = patch.stage;
      if (patch.assetId !== undefined) set.assetId = patch.assetId;
      if (patch.error !== undefined) set.error = patch.error;
      if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
      if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt;
      if (Object.keys(set).length === 0) return;
      deps.db.update(studioGenerations).set(set).where(eq(studioGenerations.id, id)).run();
    },

    interruptLive(reason: string, at: string): StudioGenerationRow[] {
      return deps.db
        .update(studioGenerations)
        .set({ status: 'failed', error: reason, finishedAt: at })
        .where(inArray(studioGenerations.status, [...LIVE_GENERATION_STATUSES]))
        .returning()
        .all();
    },

    createAsset(record: StudioAssetInsert): StudioAssetRow {
      const row = deps.db.insert(studioAssets).values(record).returning().get();
      if (row === undefined) throw new Error('the inserted asset could not be read back');
      return row;
    },

    findAsset(id: string): StudioAssetRow | null {
      return deps.db.select().from(studioAssets).where(eq(studioAssets.id, id)).get() ?? null;
    },

    listAssets(): StudioAssetRow[] {
      return deps.db
        .select()
        .from(studioAssets)
        .orderBy(desc(studioAssets.createdAt), asc(studioAssets.id))
        .all();
    },

    setFavorite(id: string, favorite: boolean): void {
      deps.db.update(studioAssets).set({ favorite }).where(eq(studioAssets.id, id)).run();
    },

    deleteAsset(id: string): void {
      deps.db.delete(studioAssets).where(eq(studioAssets.id, id)).run();
    },
  };
}
