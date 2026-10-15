import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import type { ServerConfig } from '@server/runtime/config.ts';
import * as schema from './schema.ts';

/**
 * The SQLite handle and the Drizzle wrapper over it (ADR-0004).
 *
 * `bun:sqlite` is the driver — it is built into the runtime, so there is no
 * native module to compile and no install step that can fail on a machine
 * without a toolchain. Drizzle sits on top for typed queries; the raw handle
 * stays exposed because migrations and pragmas are not ORM work.
 */

export type Db = BunSQLiteDatabase<typeof schema>;

export interface Persistence {
  readonly sqlite: Database;
  readonly db: Db;
  /** True when the database is in-memory — the shape tests run against. */
  readonly isMemory: boolean;
  /** Cheap liveness probe for the readiness surface. Never throws. */
  ping(): boolean;
  close(): void;
}

export function openPersistence(
  config: Pick<ServerConfig, 'databaseUrl' | 'dataDir'>,
): Persistence {
  const isMemory = config.databaseUrl === ':memory:';
  if (!isMemory) mkdirSync(dirname(config.databaseUrl), { recursive: true });
  mkdirSync(config.dataDir, { recursive: true });

  const sqlite = new Database(config.databaseUrl, { create: true });

  // WAL lets the dashboard's readers run while a request is being written; the
  // default rollback journal takes a write lock that blocks them. On an
  // in-memory database this is accepted and ignored.
  sqlite.exec('pragma journal_mode = wal;');
  sqlite.exec('pragma foreign_keys = on;');
  // A concurrent writer waits rather than failing with SQLITE_BUSY.
  sqlite.exec('pragma busy_timeout = 5000;');

  const db = drizzle(sqlite, { schema });

  return {
    sqlite,
    db,
    isMemory,
    ping(): boolean {
      try {
        sqlite.query('select 1').get();
        return true;
      } catch {
        return false;
      }
    },
    close(): void {
      sqlite.close();
    },
  };
}
