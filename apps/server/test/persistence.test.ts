import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { META_KEYS, createAppMetaRepository } from '@server/persistence/app-meta.ts';
import { openPersistence } from '@server/persistence/client.ts';
import { migrations } from '@server/persistence/migrations/index.ts';
import {
  MigrationError,
  currentSchemaVersion,
  runMigrations,
} from '@server/persistence/migrate.ts';
import type { Migration } from '@server/persistence/migrations/types.ts';

/**
 * The write path (C1.3).
 *
 * Every test here runs against a real SQLite database — `:memory:` for the
 * migration logic, a temporary file for the connection setup — because the
 * things being checked (transaction rollback, pragmas, `on conflict do update`)
 * are the driver's behaviour, and a mock would only assert that the mock was
 * called.
 */

function memory(): Database {
  return new Database(':memory:');
}

function tableExists(sqlite: Database, name: string): boolean {
  const row = sqlite
    .query<{ name: string }, [string]>(
      "select name from sqlite_master where type = 'table' and name = ?",
    )
    .get(name);
  return row !== null;
}

function appliedIds(sqlite: Database): number[] {
  return sqlite
    .query<{ id: number }, []>('select id from schema_migrations order by id')
    .all()
    .map((row) => row.id);
}

const first: Migration = {
  id: 1,
  name: 'one',
  statements: ['create table t_one (id integer primary key);'],
};

const second: Migration = {
  id: 2,
  name: 'two',
  statements: ['create table t_two (id integer primary key);'],
};

describe('runMigrations', () => {
  it('applies a migration and records it', () => {
    const sqlite = memory();
    const report = runMigrations(sqlite, [first]);

    expect(report.applied).toEqual([1]);
    expect(report.skipped).toEqual([]);
    expect(tableExists(sqlite, 't_one')).toBe(true);
    expect(appliedIds(sqlite)).toEqual([1]);
  });

  it('is idempotent across boots', () => {
    const sqlite = memory();
    runMigrations(sqlite, [first, second]);
    const again = runMigrations(sqlite, [first, second]);

    expect(again.applied).toEqual([]);
    expect(again.skipped).toEqual([1, 2]);
    expect(currentSchemaVersion(sqlite)).toBe(2);
  });

  it('applies only the migrations that are missing', () => {
    const sqlite = memory();
    runMigrations(sqlite, [first]);
    const report = runMigrations(sqlite, [first, second]);

    expect(report.applied).toEqual([2]);
    expect(report.skipped).toEqual([1]);
  });

  it('sorts by id rather than trusting the array order', () => {
    const sqlite = memory();
    const report = runMigrations(sqlite, [second, first]);

    expect(report.applied).toEqual([1, 2]);
  });

  it('refuses a list with a gap', () => {
    // A skipped id means someone renumbered a migration, and the id sequence is
    // the only thing that tells an existing database what it has already run.
    expect(() => runMigrations(memory(), [first, { ...second, id: 3 }])).toThrow(MigrationError);
    expect(() => runMigrations(memory(), [first, { ...second, id: 3 }])).toThrow(/contiguous/);
  });

  it('refuses a list that does not start at 1', () => {
    expect(() => runMigrations(memory(), [{ ...first, id: 2 }])).toThrow(MigrationError);
  });

  it('rolls a failed migration back, bookkeeping included', () => {
    const sqlite = memory();
    const broken: Migration = {
      id: 2,
      name: 'broken',
      statements: ['create table t_broken (id integer primary key);', 'this is not sql;'],
    };

    expect(() => runMigrations(sqlite, [first, broken])).toThrow();

    // The table it managed to create before failing must be gone with it, or the
    // next boot would try the same statements against a half-built schema.
    expect(tableExists(sqlite, 't_broken')).toBe(false);
    expect(appliedIds(sqlite)).toEqual([1]);
    expect(currentSchemaVersion(sqlite)).toBe(1);
  });
});

describe('currentSchemaVersion', () => {
  it('reports 0 before anything has been applied', () => {
    const sqlite = memory();
    runMigrations(sqlite, []);

    expect(currentSchemaVersion(sqlite)).toBe(0);
  });
});

describe('the shipped migration list', () => {
  it('creates every table the shipped migrations declare', () => {
    const sqlite = memory();
    const report = runMigrations(sqlite);

    expect(report.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(currentSchemaVersion(sqlite)).toBe(16);
    for (const name of [
      'app_meta',
      'auth_credential',
      'sessions',
      'api_keys',
      'provider_accounts',
      'aliases',
      'combos',
      'combo_entries',
      'model_mappings',
      'requests',
      'request_captures',
      'proxies',
      'sms_providers',
      'jobs',
      'job_items',
      'vcc_cards',
      'filter_rules',
      'chat_sessions',
      'chat_messages',
      'studio_generations',
      'studio_assets',
      'benchmark_runs',
      'benchmark_results',
      'verification_results',
      'verification_baselines',
      'providers',
      'provider_models',
    ]) {
      expect(tableExists(sqlite, name)).toBe(true);
    }
  });

  it('adds the columns the shipped migrations declare', () => {
    // A migration that alters a table has no new table for the sweep above to
    // find, so it would pass by adding nothing. Naming the columns is what makes
    // "the migration ran" an assertion rather than an assumption.
    const sqlite = memory();
    runMigrations(sqlite);

    const columnsOf = (table: string): string[] =>
      (sqlite.query(`pragma table_info("${table}")`).all() as { name: string }[]).map(
        (row) => row.name,
      );

    // 0016 (C14): what the Token Saver removed, per turn. Nullable, because
    // "the pipeline did not run" is the honest value for every older row.
    expect(columnsOf('requests')).toContain('token_saver_savings');
  });
});

/**
 * Upgrading a database that already has data in it (D2).
 *
 * Everything above starts from nothing: an empty handle, the full list, and an
 * assertion that the schema that came out is the one the migrations declare. That
 * is the *install* case, and it is the easy one — there is no data to lose.
 *
 * The case an operator actually hits is the other one. They are running last
 * month's build, it has rows in it, and they pull a new one. The server migrates
 * on boot with no separate step to remember, which means a migration that drops
 * or rewrites a column does its damage before anyone is watching — and the first
 * symptom is missing data on a page, days later.
 *
 * So these build an **older** database on purpose: apply a prefix of the shipped
 * list, put rows in the tables that exist at that point, and then run the whole
 * list the way a boot would. What is asserted is that the rows are still there
 * and still mean the same thing.
 *
 * The two migrations that `alter table` are the ones worth this treatment, and
 * both are covered: `0004` adds the pool's columns to `provider_accounts`, and
 * `0016` adds the Token Saver's to `requests`. Every other migration only creates
 * tables, which the install case already covers.
 */
describe('migrating a database that already has data', () => {
  const shipped = migrations;

  /** The shipped list up to and including `id`, which is an older build's schema. */
  function upTo(id: number): readonly Migration[] {
    return shipped.filter((migration) => migration.id <= id);
  }

  function countIn(sqlite: Database, table: string): number {
    const row = sqlite.query<{ n: number }, []>(`select count(*) as n from "${table}"`).get();
    return row?.n ?? 0;
  }

  it('keeps the rows a migration that adds columns was run over', () => {
    const sqlite = memory();

    // An instance from before the pool existed: `provider_accounts` has no
    // `in_flight`, no `cooldown_until`, none of the ten columns 0004 adds.
    runMigrations(sqlite, upTo(3));
    expect(currentSchemaVersion(sqlite)).toBe(3);

    sqlite.run(
      `insert into provider_accounts
         (id, provider_id, label, credential_envelope, auth_mode, state, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'acct_old',
        'openai',
        'Primary',
        'v1.envelope',
        'api-key',
        'active',
        '2026-01-01',
        '2026-01-01',
      ],
    );

    const report = runMigrations(sqlite, shipped);

    // Only the missing ones ran — the three already there are skipped, not redone.
    expect(report.applied).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(currentSchemaVersion(sqlite)).toBe(16);

    // The row survived, and the new columns took their defaults rather than
    // leaving the row unreadable.
    const row = sqlite
      .query<
        { label: string; state: string; in_flight: number; consecutive_failures: number },
        [string]
      >('select label, state, in_flight, consecutive_failures from provider_accounts where id = ?')
      .get('acct_old');
    expect(row?.label).toBe('Primary');
    expect(row?.state).toBe('active');
    expect(row?.in_flight).toBe(0);
    expect(row?.consecutive_failures).toBe(0);
  });

  it('keeps the telemetry a newer column was added over', () => {
    const sqlite = memory();

    // An instance from just before C14. Every table exists; `requests` has no
    // `token_saver_savings`.
    runMigrations(sqlite, upTo(15));
    expect(currentSchemaVersion(sqlite)).toBe(15);

    sqlite.run(
      `insert into requests (id, at, method, path, status, latency_ms, input_tokens)
       values (?, ?, ?, ?, ?, ?, ?)`,
      ['req_old', '2026-09-01T00:00:00.000Z', 'POST', '/v1/chat/completions', 200, 120, 42],
    );

    runMigrations(sqlite, shipped);

    const row = sqlite
      .query<
        { status: number; input_tokens: number; token_saver_savings: string | null },
        [string]
      >('select status, input_tokens, token_saver_savings from requests where id = ?')
      .get('req_old');

    expect(row?.status).toBe(200);
    expect(row?.input_tokens).toBe(42);
    // Null, not a zero report: the honest value for a row written by a build that
    // had no savings to record. `requestsProcessed` counts on this distinction.
    expect(row?.token_saver_savings).toBeNull();
  });

  it('survives a second boot, which is what every restart is', () => {
    const sqlite = memory();
    runMigrations(sqlite, upTo(9));
    sqlite.run(
      `insert into api_keys (id, name, prefix, secret_hash, created_at)
       values (?, ?, ?, ?, ?)`,
      ['key_old', 'laptop', 'rk-abcd', 'hash', '2026-01-01'],
    );

    // First boot after the upgrade, then the second — a restart must not re-run
    // anything, and must not touch the row either time.
    runMigrations(sqlite, shipped);
    const second = runMigrations(sqlite, shipped);

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(countIn(sqlite, 'api_keys')).toBe(1);
  });

  it('leaves a database whose schema is newer than the build alone', () => {
    // Downgrading. The build does not know what a future column means, and the
    // honest answer is to run the migrations it has and change nothing else —
    // the rows and the unknown column both stay.
    const sqlite = memory();
    runMigrations(sqlite, shipped);
    sqlite.run('alter table requests add column from_the_future text');

    const report = runMigrations(sqlite, upTo(15));

    expect(report.applied).toEqual([]);
    expect(report.skipped).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(currentSchemaVersion(sqlite)).toBe(16);
  });
});

describe('createAppMetaRepository', () => {
  it('round-trips a value', () => {
    const persistence = openPersistence({
      databaseUrl: ':memory:',
      dataDir: mkdtempSync(join(tmpdir(), 'rutekit-meta-')),
    });
    runMigrations(persistence.sqlite);
    const meta = createAppMetaRepository(persistence.db);

    meta.set(META_KEYS.bootStartedAt, '2026-01-01T00:00:00.000Z');

    expect(meta.get(META_KEYS.bootStartedAt)).toBe('2026-01-01T00:00:00.000Z');
    expect(meta.get('never.written')).toBeNull();
    persistence.close();
  });

  it('overwrites rather than accumulating rows on the second boot', () => {
    const persistence = openPersistence({
      databaseUrl: ':memory:',
      dataDir: mkdtempSync(join(tmpdir(), 'rutekit-meta-')),
    });
    runMigrations(persistence.sqlite);
    const meta = createAppMetaRepository(persistence.db);

    meta.set(META_KEYS.bootStartedAt, 'first');
    meta.set(META_KEYS.bootStartedAt, 'second');

    expect(meta.get(META_KEYS.bootStartedAt)).toBe('second');
    expect(meta.entries()).toEqual({ [META_KEYS.bootStartedAt]: 'second' });
    persistence.close();
  });

  it('lists its entries in key order', () => {
    const persistence = openPersistence({
      databaseUrl: ':memory:',
      dataDir: mkdtempSync(join(tmpdir(), 'rutekit-meta-')),
    });
    runMigrations(persistence.sqlite);
    const meta = createAppMetaRepository(persistence.db);

    meta.set(META_KEYS.schemaVersion, '1');
    meta.set(META_KEYS.bootStartedAt, 'then');

    expect(Object.keys(meta.entries())).toEqual([META_KEYS.bootStartedAt, META_KEYS.schemaVersion]);
    persistence.close();
  });
});

describe('openPersistence', () => {
  it('reports an in-memory database as such', () => {
    const persistence = openPersistence({
      databaseUrl: ':memory:',
      dataDir: mkdtempSync(join(tmpdir(), 'rutekit-p-')),
    });

    expect(persistence.isMemory).toBe(true);
    expect(persistence.ping()).toBe(true);
    persistence.close();
  });

  it('creates the parent directory of the database file', () => {
    // `data/` is git-ignored and therefore absent on a fresh clone; a first boot
    // that failed here would be the first thing every new operator hits.
    const root = mkdtempSync(join(tmpdir(), 'rutekit-p-'));
    const databaseUrl = join(root, 'nested', 'deeper', 'rutekit.sqlite');
    const persistence = openPersistence({ databaseUrl, dataDir: join(root, 'assets') });

    expect(persistence.isMemory).toBe(false);
    expect(persistence.ping()).toBe(true);
    runMigrations(persistence.sqlite);
    // The subject here is the directory, not the migration list (that pin lives
    // in the suite above), so this only asserts the run got somewhere.
    expect(currentSchemaVersion(persistence.sqlite)).toBeGreaterThan(0);
    persistence.close();
  });

  it('reports itself unhealthy once the handle is closed', () => {
    const persistence = openPersistence({
      databaseUrl: ':memory:',
      dataDir: mkdtempSync(join(tmpdir(), 'rutekit-p-')),
    });
    persistence.close();

    expect(persistence.ping()).toBe(false);
  });
});
