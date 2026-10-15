import { asc, desc, eq } from 'drizzle-orm';

import type { Db } from './client.ts';
import { vccCards } from './schema.ts';

/**
 * The virtual-card pool (C8, FR-11.2).
 *
 * The PAN and CVV go in encrypted and come back encrypted: this repository never
 * holds a `SecretBox`, because decrypting a card number is a decision about who
 * may see one and that belongs to the service, not the store — the same rule
 * `provider-accounts.ts` and `proxies.ts` follow.
 *
 * `setEnvelopes` writes the number and the CVV together, because they are
 * generated together and a row holding one without the other is a card that
 * cannot be used at the endpoint the pool exists for.
 *
 * `update` is the operator's half — status, assignment, note — and it never
 * touches the envelopes. There is no path that rewrites a number: a card whose
 * number changed is a different card, and the honest answer is to mint another.
 */

export type VccCardRow = typeof vccCards.$inferSelect;
export type VccCardInsert = typeof vccCards.$inferInsert;

/** The fields an operator may edit by hand. */
export interface VccCardPatch {
  readonly status?: string | undefined;
  readonly assignedTo?: string | null | undefined;
  readonly note?: string | null | undefined;
}

export interface VccCardsRepository {
  create(record: VccCardInsert): VccCardRow;
  listAll(): VccCardRow[];
  findById(id: string): VccCardRow | null;
  update(id: string, patch: VccCardPatch, updatedAt: string): void;
  /** Write the encrypted number and CVV for a card that has none. */
  setEnvelopes(id: string, panEnvelope: string, cvvEnvelope: string, updatedAt: string): void;
  delete(id: string): void;
}

export function createVccCardsRepository(db: Db): VccCardsRepository {
  return {
    create(record: VccCardInsert): VccCardRow {
      const row = db.insert(vccCards).values(record).returning().get();
      if (row === undefined) throw new Error('the inserted card could not be read back');
      return row;
    },

    listAll(): VccCardRow[] {
      // Newest first: a pool is read to find the batch that was just minted.
      return db.select().from(vccCards).orderBy(desc(vccCards.createdAt), asc(vccCards.id)).all();
    },

    findById(id: string): VccCardRow | null {
      return db.select().from(vccCards).where(eq(vccCards.id, id)).get() ?? null;
    },

    update(id: string, patch: VccCardPatch, updatedAt: string): void {
      const set: Partial<VccCardInsert> = { updatedAt };
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.assignedTo !== undefined) set.assignedTo = patch.assignedTo;
      if (patch.note !== undefined) set.note = patch.note;
      db.update(vccCards).set(set).where(eq(vccCards.id, id)).run();
    },

    setEnvelopes(id: string, panEnvelope: string, cvvEnvelope: string, updatedAt: string): void {
      db.update(vccCards)
        .set({ panEnvelope, cvvEnvelope, hasPan: true, updatedAt })
        .where(eq(vccCards.id, id))
        .run();
    },

    delete(id: string): void {
      db.delete(vccCards).where(eq(vccCards.id, id)).run();
    },
  };
}
