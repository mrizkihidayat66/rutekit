import { asc, eq, sql } from 'drizzle-orm';

import type { Db } from './client.ts';
import { smsProviders } from './schema.ts';

/**
 * SMS activation keys (C7a, FR-5.x).
 *
 * The same shape as the proxy pool and for the same reasons: the key goes in
 * encrypted and is never read back by a route, `keyHint` is the masked display
 * value, and the health columns move only through `recordCheck`.
 *
 * `keyHint` is stored rather than derived from the envelope, because deriving it
 * would mean decrypting on every list — a read path that has to hold the box, for
 * a value that never changes once the key is set.
 *
 * `bumpOutcome` is how C7b records that a rented number worked or did not. It is
 * a counter pair rather than a log, and it is the figure the pool's summary tiles
 * exist to show: a key that rents numbers but never receives a code is the one an
 * operator needs to find.
 */

export type SmsProviderRow = typeof smsProviders.$inferSelect;
export type SmsProviderInsert = typeof smsProviders.$inferInsert;

/** The fields an operator may edit by hand. */
export interface SmsProviderPatch {
  readonly kind?: string | undefined;
  readonly label?: string | undefined;
  readonly country?: string | null | undefined;
  readonly operator?: string | null | undefined;
  readonly product?: string | null | undefined;
  readonly note?: string | null | undefined;
}

/** What one balance check learned. */
export interface SmsCheckWrite {
  readonly status: string;
  readonly balance: number | null;
  readonly currency: string | null;
}

export interface SmsProvidersRepository {
  create(record: SmsProviderInsert): SmsProviderRow;
  listAll(): SmsProviderRow[];
  findById(id: string): SmsProviderRow | null;
  /** The stored envelope, for the checker. Never handed to a route. */
  credentialEnvelope(id: string): string | null;
  update(id: string, patch: SmsProviderPatch, updatedAt: string): void;
  /** Replace the key and its hint together, so the two cannot disagree. */
  setCredential(id: string, credentialEnvelope: string, keyHint: string, updatedAt: string): void;
  recordCheck(id: string, result: SmsCheckWrite, checkedAt: string): void;
  /** A rented number that received its code, or one that did not. */
  bumpOutcome(id: string, succeeded: boolean): void;
  delete(id: string): void;
}

export function createSmsProvidersRepository(db: Db): SmsProvidersRepository {
  return {
    create(record: SmsProviderInsert): SmsProviderRow {
      const row = db.insert(smsProviders).values(record).returning().get();
      if (row === undefined) throw new Error('the inserted SMS provider could not be read back');
      return row;
    },

    listAll(): SmsProviderRow[] {
      return db
        .select()
        .from(smsProviders)
        .orderBy(asc(smsProviders.createdAt), asc(smsProviders.id))
        .all();
    },

    findById(id: string): SmsProviderRow | null {
      return db.select().from(smsProviders).where(eq(smsProviders.id, id)).get() ?? null;
    },

    credentialEnvelope(id: string): string | null {
      const row = db
        .select({ envelope: smsProviders.credentialEnvelope })
        .from(smsProviders)
        .where(eq(smsProviders.id, id))
        .get();
      return row?.envelope ?? null;
    },

    update(id: string, patch: SmsProviderPatch, updatedAt: string): void {
      const set: Partial<SmsProviderInsert> = { updatedAt };
      if (patch.kind !== undefined) set.kind = patch.kind;
      if (patch.label !== undefined) set.label = patch.label;
      if (patch.country !== undefined) set.country = patch.country;
      if (patch.operator !== undefined) set.operator = patch.operator;
      if (patch.product !== undefined) set.product = patch.product;
      if (patch.note !== undefined) set.note = patch.note;
      db.update(smsProviders).set(set).where(eq(smsProviders.id, id)).run();
    },

    setCredential(
      id: string,
      credentialEnvelope: string,
      keyHint: string,
      updatedAt: string,
    ): void {
      db.update(smsProviders)
        .set({ credentialEnvelope, keyHint, updatedAt })
        .where(eq(smsProviders.id, id))
        .run();
    },

    recordCheck(id: string, result: SmsCheckWrite, checkedAt: string): void {
      db.update(smsProviders)
        .set({
          status: result.status,
          balance: result.balance,
          currency: result.currency,
          lastCheckedAt: checkedAt,
          updatedAt: checkedAt,
        })
        .where(eq(smsProviders.id, id))
        .run();
    },

    bumpOutcome(id: string, succeeded: boolean): void {
      // An in-place increment rather than a read-modify-write: several workers
      // rent from one key at once, and a read-then-write would lose one of two
      // outcomes landing in the same instant.
      db.update(smsProviders)
        .set(
          succeeded
            ? { successCount: sql`${smsProviders.successCount} + 1` }
            : { failCount: sql`${smsProviders.failCount} + 1` },
        )
        .where(eq(smsProviders.id, id))
        .run();
    },

    delete(id: string): void {
      db.delete(smsProviders).where(eq(smsProviders.id, id)).run();
    },
  };
}
