import { asc, desc, eq } from 'drizzle-orm';

import type { Db } from './client.ts';
import { verificationBaselines, verificationResults } from './schema.ts';

/**
 * Verification results and the baselines they are measured against (C12, FR-10.x).
 *
 * Two lifetimes in one file: a result is written once and read back as history,
 * while a baseline is written by a calibration and read by every later
 * verification. Neither is ever updated in place — a re-run of a verification is
 * a new result, and a re-calibration replaces a subject's distributions rather
 * than editing them token by token.
 *
 * **`putBaselines` replaces a whole subject in one transaction.** A calibration
 * that wrote three of four probes and then failed would leave a subject whose
 * reference is half old and half new, and every JSD measured against it would be
 * a number computed from two different endpoints. The delete and the inserts are
 * one step for that reason.
 */

export type VerificationResultRow = typeof verificationResults.$inferSelect;
export type VerificationResultInsert = typeof verificationResults.$inferInsert;
export type VerificationBaselineRow = typeof verificationBaselines.$inferSelect;
export type VerificationBaselineInsert = typeof verificationBaselines.$inferInsert;

/** One probe's reference, as the calibration produced it. */
export interface BaselineWrite {
  readonly probeId: string;
  readonly distribution: Record<string, number>;
  readonly samples: number;
}

export interface VerificationRepository {
  createResult(record: VerificationResultInsert): VerificationResultRow;
  findResult(id: string): VerificationResultRow | null;
  listResults(): VerificationResultRow[];

  /** Every reference for one subject, keyed by probe id. */
  baselinesFor(subject: string): ReadonlyMap<string, VerificationBaselineRow>;
  /** Replace a subject's references wholesale, with the endpoint they came from. */
  putBaselines(
    subject: string,
    isFamily: boolean,
    measuredFrom: { readonly providerId: string; readonly model: string },
    writes: readonly BaselineWrite[],
    calibratedAt: string,
  ): void;
  /** Which subjects have any reference at all, newest calibration first. */
  baselineSubjects(): readonly { readonly subject: string; readonly isFamily: boolean; readonly calibratedAt: string }[];
  /** One subject's references, for the console. */
  baselineRows(subject: string): VerificationBaselineRow[];
  removeBaselines(subject: string): void;
}

export interface VerificationRepositoryDeps {
  readonly db: Db;
}

export function createVerificationRepository(
  deps: VerificationRepositoryDeps,
): VerificationRepository {
  return {
    createResult(record: VerificationResultInsert): VerificationResultRow {
      const row = deps.db.insert(verificationResults).values(record).returning().get();
      if (row === undefined) throw new Error('the inserted verification result could not be read back');
      return row;
    },

    findResult(id: string): VerificationResultRow | null {
      return (
        deps.db.select().from(verificationResults).where(eq(verificationResults.id, id)).get() ?? null
      );
    },

    listResults(): VerificationResultRow[] {
      // Newest first: a history is read to find the verification just run.
      return deps.db
        .select()
        .from(verificationResults)
        .orderBy(desc(verificationResults.createdAt), asc(verificationResults.id))
        .all();
    },

    baselinesFor(subject: string): ReadonlyMap<string, VerificationBaselineRow> {
      const rows = deps.db
        .select()
        .from(verificationBaselines)
        .where(eq(verificationBaselines.subject, subject))
        .all();
      return new Map(rows.map((row) => [row.probeId, row]));
    },

    putBaselines(subject, isFamily, measuredFrom, writes, calibratedAt): void {
      deps.db.transaction((tx) => {
        tx.delete(verificationBaselines).where(eq(verificationBaselines.subject, subject)).run();
        for (const write of writes) {
          tx.insert(verificationBaselines)
            .values({
              subject,
              probeId: write.probeId,
              isFamily,
              distribution: write.distribution,
              samples: write.samples,
              providerId: measuredFrom.providerId,
              model: measuredFrom.model,
              calibratedAt,
            })
            .run();
        }
      });
    },

    baselineSubjects(): readonly { subject: string; isFamily: boolean; calibratedAt: string }[] {
      const rows = deps.db
        .select({
          subject: verificationBaselines.subject,
          isFamily: verificationBaselines.isFamily,
          calibratedAt: verificationBaselines.calibratedAt,
        })
        .from(verificationBaselines)
        .all();

      // One row per subject, carrying its newest calibration — a subject holds
      // several probes and they are always written together, but reading the
      // maximum rather than the first keeps this correct if they ever are not.
      const bySubject = new Map<string, { subject: string; isFamily: boolean; calibratedAt: string }>();
      for (const row of rows) {
        const current = bySubject.get(row.subject);
        if (current === undefined || row.calibratedAt > current.calibratedAt) {
          bySubject.set(row.subject, {
            subject: row.subject,
            isFamily: row.isFamily,
            calibratedAt: row.calibratedAt,
          });
        }
      }
      return [...bySubject.values()].sort((a, b) => b.calibratedAt.localeCompare(a.calibratedAt));
    },

    baselineRows(subject: string): VerificationBaselineRow[] {
      return deps.db
        .select()
        .from(verificationBaselines)
        .where(eq(verificationBaselines.subject, subject))
        .orderBy(asc(verificationBaselines.probeId))
        .all();
    },

    removeBaselines(subject: string): void {
      deps.db.delete(verificationBaselines).where(eq(verificationBaselines.subject, subject)).run();
    },
  };
}
