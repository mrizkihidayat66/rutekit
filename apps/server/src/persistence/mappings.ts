import { asc, eq } from 'drizzle-orm';

import type { Db } from './client.ts';
import { modelMappings } from './schema.ts';

/**
 * Model mapping rules (FR-1.5).
 *
 * `listOrdered` is the only list method, and it is the one resolution calls: the
 * rules are a pipeline, so the order they come back in *is* the answer to "which
 * one ran first". Priority ascending, then creation order — the same tie-break
 * `mappingInputSchema` describes, so a reader comparing two rules with equal
 * priority sees the older one win rather than whichever row SQLite happened to
 * return first.
 *
 * The `created_at` column carries the tie-break rather than the id: an id is a
 * random UUID, and sorting on one would make the order of two equal-priority
 * rules change every time a rule was re-created.
 */

export type MappingRow = typeof modelMappings.$inferSelect;
export type MappingInsert = typeof modelMappings.$inferInsert;

export interface MappingPatch {
  readonly match?: string | undefined;
  readonly pattern?: string | undefined;
  readonly replacement?: string | undefined;
  readonly priority?: number | undefined;
  readonly enabled?: boolean | undefined;
  readonly description?: string | null | undefined;
}

export interface MappingsRepository {
  create(record: MappingInsert): MappingRow;
  listOrdered(): MappingRow[];
  findById(id: string): MappingRow | null;
  update(id: string, patch: MappingPatch, updatedAt: string): void;
  delete(id: string): void;
}

export function createMappingsRepository(db: Db): MappingsRepository {
  return {
    create(record: MappingInsert): MappingRow {
      const row = db.insert(modelMappings).values(record).returning().get();
      if (row === undefined) throw new Error('the inserted mapping could not be read back');
      return row;
    },

    listOrdered(): MappingRow[] {
      return db
        .select()
        .from(modelMappings)
        .orderBy(asc(modelMappings.priority), asc(modelMappings.createdAt), asc(modelMappings.id))
        .all();
    },

    findById(id: string): MappingRow | null {
      return db.select().from(modelMappings).where(eq(modelMappings.id, id)).get() ?? null;
    },

    update(id: string, patch: MappingPatch, updatedAt: string): void {
      const set: Partial<MappingInsert> = { updatedAt };
      if (patch.match !== undefined) set.match = patch.match;
      if (patch.pattern !== undefined) set.pattern = patch.pattern;
      if (patch.replacement !== undefined) set.replacement = patch.replacement;
      if (patch.priority !== undefined) set.priority = patch.priority;
      if (patch.enabled !== undefined) set.enabled = patch.enabled;
      if (patch.description !== undefined) set.description = patch.description;
      db.update(modelMappings).set(set).where(eq(modelMappings.id, id)).run();
    },

    delete(id: string): void {
      db.delete(modelMappings).where(eq(modelMappings.id, id)).run();
    },
  };
}
