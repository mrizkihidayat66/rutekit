import { asc, eq } from 'drizzle-orm';

import type { Db } from './client.ts';
import { aliases } from './schema.ts';

/**
 * Aliases (FR-1.3): the friendly name a client sends, and the model id it means.
 *
 * The table is small enough that `listAll` is the only list method — resolution
 * reads every enabled alias once per turn, and an instance holds tens of them.
 * The unique index on `alias` is what makes `findByAlias` a lookup rather than a
 * scan, and it is also the reason two aliases can never disagree about a name.
 *
 * `setProviderId` is not offered as a separate write: unlike an account's state,
 * nothing about an alias moves on its own, so every change to one is an operator's
 * and arrives through `update`.
 */

export type AliasRow = typeof aliases.$inferSelect;
export type AliasInsert = typeof aliases.$inferInsert;

export interface AliasPatch {
  readonly target?: string | undefined;
  readonly providerId?: string | null | undefined;
  readonly enabled?: boolean | undefined;
  readonly description?: string | null | undefined;
}

export interface AliasesRepository {
  create(record: AliasInsert): AliasRow;
  listAll(): AliasRow[];
  findById(id: string): AliasRow | null;
  findByAlias(alias: string): AliasRow | null;
  update(id: string, patch: AliasPatch, updatedAt: string): void;
  delete(id: string): void;
}

export function createAliasesRepository(db: Db): AliasesRepository {
  return {
    create(record: AliasInsert): AliasRow {
      const row = db.insert(aliases).values(record).returning().get();
      if (row === undefined) throw new Error('the inserted alias could not be read back');
      return row;
    },

    listAll(): AliasRow[] {
      // Created order, with the id as a tie-break so two aliases made in the same
      // millisecond keep a stable place. The console sorts by whatever column the
      // operator picked; this is only the order an unsorted list comes back in.
      return db
        .select()
        .from(aliases)
        .orderBy(asc(aliases.createdAt), asc(aliases.id))
        .all();
    },

    findById(id: string): AliasRow | null {
      return db.select().from(aliases).where(eq(aliases.id, id)).get() ?? null;
    },

    findByAlias(alias: string): AliasRow | null {
      return db.select().from(aliases).where(eq(aliases.alias, alias)).get() ?? null;
    },

    update(id: string, patch: AliasPatch, updatedAt: string): void {
      const set: Partial<AliasInsert> = { updatedAt };
      if (patch.target !== undefined) set.target = patch.target;
      if (patch.providerId !== undefined) set.providerId = patch.providerId;
      if (patch.enabled !== undefined) set.enabled = patch.enabled;
      if (patch.description !== undefined) set.description = patch.description;
      db.update(aliases).set(set).where(eq(aliases.id, id)).run();
    },

    delete(id: string): void {
      db.delete(aliases).where(eq(aliases.id, id)).run();
    },
  };
}
