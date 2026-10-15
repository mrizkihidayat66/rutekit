import type { Database } from 'bun:sqlite';

import { migrations as defaultMigrations } from './migrations/index.ts';
import type { Migration } from './migrations/types.ts';

/**
 * Applies the numbered migrations at boot (A22, NFR-7).
 *
 * There is no separate migrate step to remember: the server brings its own
 * database up to date on start, records what it applied, and refuses to start if
 * the list is malformed. Each migration runs in its own transaction together
 * with its bookkeeping row, so a failure halfway leaves the database at the last
 * good version rather than in a state that is neither.
 */

export interface MigrationReport {
  readonly applied: readonly number[];
  readonly skipped: readonly number[];
}

interface IdRow {
  id: number;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export function runMigrations(
  sqlite: Database,
  list: readonly Migration[] = defaultMigrations,
): MigrationReport {
  sqlite.exec(`create table if not exists schema_migrations (
    id integer primary key,
    name text not null,
    applied_at text not null
  );`);

  const ordered = [...list].sort((a, b) => a.id - b.id);
  for (const [index, migration] of ordered.entries()) {
    if (migration.id !== index + 1) {
      throw new MigrationError(
        `migration ids must be contiguous from 1; found id ${migration.id} at position ${index + 1}`,
      );
    }
  }

  const alreadyApplied = new Set(
    sqlite
      .query<IdRow, []>('select id from schema_migrations')
      .all()
      .map((row) => row.id),
  );

  const applied: number[] = [];
  const skipped: number[] = [];

  for (const migration of ordered) {
    if (alreadyApplied.has(migration.id)) {
      skipped.push(migration.id);
      continue;
    }
    const apply = sqlite.transaction(() => {
      for (const statement of migration.statements) sqlite.exec(statement);
      sqlite.run('insert into schema_migrations (id, name, applied_at) values (?, ?, ?)', [
        migration.id,
        migration.name,
        new Date().toISOString(),
      ]);
    });
    apply();
    applied.push(migration.id);
  }

  return { applied, skipped };
}

/** The highest applied id, or 0 on a fresh database. Shown on the health surface. */
export function currentSchemaVersion(sqlite: Database): number {
  const row = sqlite
    .query<{ version: number | null }, []>('select max(id) as version from schema_migrations')
    .get();
  return row?.version ?? 0;
}
