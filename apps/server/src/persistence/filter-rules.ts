import { asc, eq } from 'drizzle-orm';

import type { Db } from './client.ts';
import { filterRules } from './schema.ts';

/**
 * Content filter rules (C8, FR-11.3).
 *
 * `listOrdered` is the only list method and the one the pipeline calls: a rule
 * set is a sequence, and the order the operator arranged it in is the order the
 * phases run it. Phase first, then position — so a phase-1 rule always runs
 * before a phase-2 one however the two were created, which is the order the
 * pipeline itself runs in.
 *
 * The `position` column is rewritten on every save, so it describes the current
 * arrangement rather than when a rule was added.
 */

export type FilterRuleRow = typeof filterRules.$inferSelect;
export type FilterRuleInsert = typeof filterRules.$inferInsert;

export interface FilterRulePatch {
  readonly name?: string | undefined;
  readonly kind?: string | undefined;
  readonly pattern?: string | undefined;
  readonly action?: string | undefined;
  readonly phase?: number | undefined;
  readonly enabled?: boolean | undefined;
}

export interface FilterRulesRepository {
  create(record: FilterRuleInsert): FilterRuleRow;
  listOrdered(): FilterRuleRow[];
  findById(id: string): FilterRuleRow | null;
  update(id: string, patch: FilterRulePatch, updatedAt: string): void;
  delete(id: string): void;
}

export function createFilterRulesRepository(db: Db): FilterRulesRepository {
  return {
    create(record: FilterRuleInsert): FilterRuleRow {
      const row = db.insert(filterRules).values(record).returning().get();
      if (row === undefined) throw new Error('the inserted filter rule could not be read back');
      return row;
    },

    listOrdered(): FilterRuleRow[] {
      return db
        .select()
        .from(filterRules)
        .orderBy(asc(filterRules.phase), asc(filterRules.position), asc(filterRules.createdAt))
        .all();
    },

    findById(id: string): FilterRuleRow | null {
      return db.select().from(filterRules).where(eq(filterRules.id, id)).get() ?? null;
    },

    update(id: string, patch: FilterRulePatch, updatedAt: string): void {
      const set: Partial<FilterRuleInsert> = { updatedAt };
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.kind !== undefined) set.kind = patch.kind;
      if (patch.pattern !== undefined) set.pattern = patch.pattern;
      if (patch.action !== undefined) set.action = patch.action;
      if (patch.phase !== undefined) set.phase = patch.phase;
      if (patch.enabled !== undefined) set.enabled = patch.enabled;
      db.update(filterRules).set(set).where(eq(filterRules.id, id)).run();
    },

    delete(id: string): void {
      db.delete(filterRules).where(eq(filterRules.id, id)).run();
    },
  };
}
