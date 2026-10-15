import { asc, eq } from 'drizzle-orm';

import type { Db } from './client.ts';
import { comboEntries, combos } from './schema.ts';

/**
 * Combos and their entries (FR-1.4).
 *
 * A combo is one record and a list, and they are written together or not at all:
 * `create` inserts the combo and its entries, `replaceEntries` swaps the whole
 * list, and `delete` takes the entries with the combo. That is why this is one
 * repository rather than two — an entries-only repository would let a caller
 * leave a combo holding half a chain, and nothing here has a legitimate reason to
 * touch an entry without its parent.
 *
 * `replaceEntries` deletes and re-inserts rather than diffing. Positions are
 * dense and rewrite on every save, so a diff would have to renumber anyway; the
 * insert is the simpler way to say "this is the chain now".
 *
 * `listAll` reads every combo with its entries in two queries rather than one per
 * combo: a `select ... in (...)` would still need the entries grouped in
 * JavaScript, and an instance holds tens of combos.
 */

export type ComboRow = typeof combos.$inferSelect;
export type ComboEntryRow = typeof comboEntries.$inferSelect;
export type ComboInsert = typeof combos.$inferInsert;

/** An entry as the service hands it over: no id and no position yet. */
export interface ComboEntryWrite {
  readonly model: string;
  readonly providerId: string | null;
  readonly weight: number;
  readonly enabled: boolean;
}

export interface ComboPatch {
  readonly displayName?: string | undefined;
  readonly description?: string | null | undefined;
  readonly strategy?: string | undefined;
  readonly fallbackOnError?: boolean | undefined;
  readonly enabled?: boolean | undefined;
}

/** A combo and its entries, as stored. */
export interface ComboWithEntries {
  readonly combo: ComboRow;
  readonly entries: readonly ComboEntryRow[];
}

export interface CombosRepository {
  create(combo: ComboInsert, entries: readonly ComboEntryWrite[]): ComboWithEntries;
  listAll(): ComboWithEntries[];
  findById(id: string): ComboWithEntries | null;
  findByName(name: string): ComboWithEntries | null;
  update(id: string, patch: ComboPatch, updatedAt: string): void;
  /** Swap the whole chain. Positions are reassigned from the array's order. */
  replaceEntries(comboId: string, entries: readonly ComboEntryWrite[]): void;
  delete(id: string): void;
}

export function createCombosRepository(db: Db): CombosRepository {
  function entriesOf(comboId: string): ComboEntryRow[] {
    return db
      .select()
      .from(comboEntries)
      .where(eq(comboEntries.comboId, comboId))
      .orderBy(asc(comboEntries.position))
      .all();
  }

  function insertEntries(comboId: string, entries: readonly ComboEntryWrite[]): void {
    entries.forEach((entry, position) => {
      db.insert(comboEntries)
        .values({
          id: crypto.randomUUID(),
          comboId,
          model: entry.model,
          providerId: entry.providerId,
          weight: entry.weight,
          enabled: entry.enabled,
          position,
        })
        .run();
    });
  }

  function withEntries(combo: ComboRow): ComboWithEntries {
    return { combo, entries: entriesOf(combo.id) };
  }

  return {
    create(combo: ComboInsert, entries: readonly ComboEntryWrite[]): ComboWithEntries {
      const row = db.insert(combos).values(combo).returning().get();
      if (row === undefined) throw new Error('the inserted combo could not be read back');
      insertEntries(row.id, entries);
      return withEntries(row);
    },

    listAll(): ComboWithEntries[] {
      return db
        .select()
        .from(combos)
        .orderBy(asc(combos.createdAt), asc(combos.id))
        .all()
        .map(withEntries);
    },

    findById(id: string): ComboWithEntries | null {
      const row = db.select().from(combos).where(eq(combos.id, id)).get();
      return row === undefined ? null : withEntries(row);
    },

    findByName(name: string): ComboWithEntries | null {
      const row = db.select().from(combos).where(eq(combos.name, name)).get();
      return row === undefined ? null : withEntries(row);
    },

    update(id: string, patch: ComboPatch, updatedAt: string): void {
      const set: Partial<ComboInsert> = { updatedAt };
      if (patch.displayName !== undefined) set.displayName = patch.displayName;
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.strategy !== undefined) set.strategy = patch.strategy;
      if (patch.fallbackOnError !== undefined) set.fallbackOnError = patch.fallbackOnError;
      if (patch.enabled !== undefined) set.enabled = patch.enabled;
      db.update(combos).set(set).where(eq(combos.id, id)).run();
    },

    replaceEntries(comboId: string, entries: readonly ComboEntryWrite[]): void {
      db.delete(comboEntries).where(eq(comboEntries.comboId, comboId)).run();
      insertEntries(comboId, entries);
    },

    delete(id: string): void {
      db.delete(comboEntries).where(eq(comboEntries.comboId, id)).run();
      db.delete(combos).where(eq(combos.id, id)).run();
    },
  };
}
