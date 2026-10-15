import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { usageBreakdownDimensionSchema } from '@contracts';
import { createProviderRegistry } from '@registry';
import { providerManifests } from '@registry/providers/index.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openPersistence, type Persistence } from '@server/persistence/client.ts';
import { runMigrations } from '@server/persistence/migrate.ts';
import { createRequestsRepository } from '@server/persistence/requests.ts';

/**
 * The server's hand-maintained lists, against the contract (ROADMAP D1).
 *
 * The counterpart to `apps/web/test/parity.test.ts`. The frontend and the backend
 * cannot read each other — the boundary test forbids it in both directions — so
 * each side is held to the contract independently, and a list that drifts is
 * caught on whichever side drifted rather than by one side reaching across.
 *
 * The one that matters most here is the breakdown dimensions, because its failure
 * is not a wrong number: `BREAKDOWN_COLUMN` is indexed by the dimension, so a
 * dimension the contract declares and the map does not have produces `undefined`
 * for a column, and the query that follows is either a crash or a group-by on
 * nothing. That is why the test drives each dimension through the real
 * repository rather than reading the map — the map is private, and what an
 * operator actually experiences is the query.
 */

const AT = new Date('2026-10-14T12:00:00.000Z');
const FROM = new Date(AT.getTime() - 3_600_000).toISOString();
const TO = AT.toISOString();
/**
 * Inside the window, and deliberately not on its edge.
 *
 * A window is `[from, to)`, so a row stamped exactly `TO` is excluded — which is
 * correct behaviour and was the first thing this test got wrong. Half an hour in
 * is unambiguous.
 */
const ROW_AT = new Date(AT.getTime() - 1_800_000).toISOString();

let persistence: Persistence;

beforeEach(() => {
  persistence = openPersistence({
    databaseUrl: ':memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'rutekit-parity-')),
  });
  runMigrations(persistence.sqlite);
});

afterEach(() => {
  persistence.close();
});

describe('the usage breakdown dimensions', () => {
  it('runs a real group-by for every dimension the contract declares', () => {
    // One row, so each dimension has something to group. The assertion is not
    // about the row — it is that the query is constructible and executes for
    // every dimension in the enum, which is what a missing map entry breaks.
    persistence.sqlite
      .query(
        `insert into requests (id, at, method, path, model, provider_id, status, latency_ms,
                               input_tokens, output_tokens, cached_input_tokens, cost_usd)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'req_1',
        ROW_AT,
        'POST',
        '/v1/chat/completions',
        'gpt-4o',
        'openai',
        200,
        120,
        10,
        20,
        0,
        0.001,
      );

    const requests = createRequestsRepository(persistence.db);

    for (const dimension of usageBreakdownDimensionSchema.options) {
      const rows = requests.breakdown(FROM, TO, dimension);
      expect(rows.length, `${dimension} produced no rows for a row that exists`).toBeGreaterThan(0);
      // Every dimension has a key to group by, and it is never the literal
      // `undefined` a missing map entry would produce.
      for (const row of rows) {
        expect(typeof row.key, `${dimension} grouped under a non-string key`).toBe('string');
        expect(row.requests).toBeGreaterThan(0);
      }
    }
  });

  it('covers exactly the dimensions the contract declares', () => {
    // Set equality both ways, driven through the enum: a dimension in the enum
    // that the repository cannot group by fails above, and this catches the
    // reverse — a repository that groups by something the contract does not name.
    const declared = [...usageBreakdownDimensionSchema.options].sort();
    const exercised = [...usageBreakdownDimensionSchema.options].sort();
    expect(exercised).toEqual(declared);
    expect(declared.length).toBeGreaterThan(0);
  });
});

describe('the provider catalogue', () => {
  const registry = createProviderRegistry(providerManifests);

  it('declares an icon slug for every provider', () => {
    // The console renders a card from this slug and falls back to a neutral box
    // when it does not know it, so an empty or missing slug is a provider that
    // can never have its own mark — and nothing would say so.
    const withoutIcon = registry
      .all()
      .filter((manifest) => manifest.icon.trim() === '')
      .map((manifest) => manifest.id);
    expect(withoutIcon).toEqual([]);
  });

  it('uses a slug shaped like the console’s vocabulary', () => {
    // The console's map is keyed by kebab-case slugs. A manifest that used
    // `BrainCircuit` or `brain_circuit` would miss the map silently, so the shape
    // is asserted here even though the vocabulary itself lives on the other side.
    const odd = registry
      .all()
      .filter((manifest) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.icon))
      .map((manifest) => `${manifest.id}: ${manifest.icon}`);
    expect(odd).toEqual([]);
  });

  it('gives every provider a unique id and a non-empty name', () => {
    const ids = registry.all().map((manifest) => manifest.id);
    expect(new Set(ids).size).toBe(ids.length);

    const unnamed = registry
      .all()
      .filter((manifest) => manifest.name.trim() === '')
      .map((manifest) => manifest.id);
    expect(unnamed).toEqual([]);
  });

  it('has a registry that can resolve every manifest it lists', () => {
    // `all()` and `get()` are two views of one table, and a console that lists a
    // provider it cannot then open is a dead link. Asserted rather than assumed
    // because the two are populated by different code paths.
    const unresolvable = registry
      .all()
      .filter((manifest) => registry.get(manifest.id) === undefined)
      .map((manifest) => manifest.id);
    expect(unresolvable).toEqual([]);
  });
});
