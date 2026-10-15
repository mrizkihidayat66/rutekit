import { asc, eq } from 'drizzle-orm';

import type { Db } from './client.ts';
import { appMeta } from './schema.ts';

/**
 * The repository pattern, in its smallest useful form.
 *
 * Every later domain repository follows this shape: a factory that closes over
 * the database and returns plain methods, so a route handler never sees a query
 * builder and the SQL for one table lives in one file (R5.2).
 */

/** Keys this repository is known to hold. Keeps typos out of the meta table. */
export const META_KEYS = {
  /** ISO timestamp written on every boot; the first proof the write path works. */
  bootStartedAt: 'boot.started_at',
  /** Schema version the running process expects, for drift detection. */
  schemaVersion: 'schema.version',
  /** The Token Saver settings record, as one JSON object (FR-1.2 / A3). */
  tokenSaver: 'token_saver.config',
  /** The pool's load-balancing mode, as one bare enum value (FR-3.2). */
  poolStrategy: 'pool.strategy',
  /** The general settings record, as one JSON object (FR-12.2, low-stress mode). */
  generalSettings: 'settings.general',
  /** The appearance record, as one JSON object (C13b). */
  customization: 'settings.customization',
} as const;

export type MetaKey = (typeof META_KEYS)[keyof typeof META_KEYS];

export interface AppMetaRepository {
  get(key: string): string | null;
  set(key: string, value: string): void;
  entries(): Readonly<Record<string, string>>;
}

export function createAppMetaRepository(db: Db): AppMetaRepository {
  return {
    get(key: string): string | null {
      const row = db.select().from(appMeta).where(eq(appMeta.key, key)).get();
      return row?.value ?? null;
    },

    set(key: string, value: string): void {
      const updatedAt = new Date().toISOString();
      db.insert(appMeta)
        .values({ key, value, updatedAt })
        .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt } })
        .run();
    },

    entries(): Readonly<Record<string, string>> {
      const rows = db.select().from(appMeta).orderBy(asc(appMeta.key)).all();
      return Object.fromEntries(rows.map((row) => [row.key, row.value]));
    },
  };
}
