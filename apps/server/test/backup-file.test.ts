import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_API_PREFIX,
  backupArchiveSchema,
  consolePaths,
  restoreResultSchema,
} from '@contracts';
import type { BackupArchive } from '@contracts';

import { buildApp } from '@server/app.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * Backup and restore through a real file (D2).
 *
 * `system-routes.test.ts` already covers the round trip, but it does it entirely
 * in memory: the archive is parsed from the response body and handed straight
 * back. That is a test of the *handler*, and it is a good one — but it never
 * touches a disk, and the thing an operator actually does is save a file and load
 * it again later, possibly on another machine, possibly after editing it.
 *
 * The gap that leaves is specific and worth naming: **JSON that survives a round
 * trip through an object is not the same as JSON that survives a round trip
 * through a file.** A `Uint8Array`, a `Map`, or a value with a `toJSON` that
 * disagrees with `JSON.stringify` all round-trip fine in memory and change shape
 * on disk. So this writes the bytes, reads them back, and asserts the archive
 * that comes out the far side is the one that went in.
 *
 * It also covers the D2 item about telemetry. `requests` and `request_captures`
 * are in the archive's restorable set, and restore **replaces** rather than
 * merges — which is what makes "import without duplication" true by construction
 * rather than by a de-duplicating step. That is a claim worth a test: a restore
 * that merged would double every row, and nothing in the suite said otherwise.
 */

const PASSWORD = 'correct-horse-battery';

type App = ReturnType<typeof buildApp>;

const servers: TestServer[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
});

async function signIn(app: App): Promise<string> {
  const response = await app.request(`${CONSOLE_API_PREFIX}${consolePaths.authSetup}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, instanceName: 'Test' }),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) throw new Error('setup did not set a session cookie');
  const pair = setCookie.split(';')[0];
  if (pair === undefined) throw new Error('empty set-cookie header');
  return pair;
}

interface Harness {
  readonly server: TestServer;
  readonly app: App;
  readonly cookie: string;
}

async function harness(): Promise<Harness> {
  const server = makeServer();
  server.lifecycle.markReady();
  servers.push(server);
  const app = buildApp(server);
  return { server, app, cookie: await signIn(app) };
}

/** Export through the route and write the response bytes to a real file. */
async function exportToFile(h: Harness, name: string): Promise<string> {
  const response = await h.app.request(`${CONSOLE_API_PREFIX}${consolePaths.backup}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: h.cookie },
    body: JSON.stringify({ includeCredentials: false }),
  });
  expect(response.status).toBe(200);

  // The bytes, not the parsed object — which is the whole point of this file.
  const text = await response.text();
  const path = join(h.server.dataDir, name);
  writeFileSync(path, text, 'utf8');
  return path;
}

/** Read a file back off disk and post it the way the console does. */
async function restoreFromFile(h: Harness, path: string): Promise<Response> {
  const text = readFileSync(path, 'utf8');
  return h.app.request(`${CONSOLE_API_PREFIX}${consolePaths.restore}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: h.cookie },
    body: JSON.stringify({
      archive: Buffer.from(text, 'utf8').toString('base64'),
      confirm: true,
    }),
  });
}

function archiveOf(path: string): BackupArchive {
  return backupArchiveSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

function seedProvider(h: Harness, id: string, name: string): void {
  h.server.persistence.sqlite
    .query(
      `insert into providers (id, name, category, wire_family, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, name, 'byok', 'openai', '2026-01-01', '2026-01-01');
}

function seedRequest(h: Harness, id: string, at: string): void {
  h.server.persistence.sqlite
    .query(
      `insert into requests (id, at, method, path, status, latency_ms, input_tokens, output_tokens)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, at, 'POST', '/v1/chat/completions', 200, 120, 10, 20);
}

function seedCapture(h: Harness, id: string, requestId: string): void {
  h.server.persistence.sqlite
    .query(
      `insert into request_captures
         (id, request_id, stage, body, byte_size, truncated, redacted, captured_at, expires_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      requestId,
      'client_request',
      '{}',
      2,
      0,
      0,
      '2026-10-14T00:00:00.000Z',
      '2030-01-01T00:00:00.000Z',
    );
}

function countIn(h: Harness, table: string): number {
  const row = h.server.persistence.sqlite.query(`select count(*) as n from "${table}"`).get() as {
    n: number;
  };
  return row.n;
}

const providerIds = (h: Harness): string[] =>
  (
    h.server.persistence.sqlite.query('select id from providers order by id').all() as {
      id: string;
    }[]
  ).map((row) => row.id);

describe('an archive on disk', () => {
  it('is the same archive after a trip through a file', async () => {
    const h = await harness();
    seedProvider(h, 'prov_1', 'My Endpoint');

    const path = await exportToFile(h, 'round-trip.json');
    const archive = archiveOf(path);

    expect(archive.format).toBe(1);
    expect(archive.tables.providers).toHaveLength(1);
    // Parsing the file the same way the route parses an upload is the assertion:
    // anything that survives `JSON.stringify` but not a file would fail here.
    expect(archive.tables.providers?.[0]?.name).toBe('My Endpoint');
  });

  it('restores an instance from a file written earlier', async () => {
    const h = await harness();
    seedProvider(h, 'prov_original', 'Original');
    const path = await exportToFile(h, 'earlier.json');

    // Something else entirely, the way an instance looks before a restore.
    h.server.persistence.sqlite.query('delete from providers').run();
    seedProvider(h, 'prov_replacement', 'Replacement');

    const response = await restoreFromFile(h, path);

    expect(response.status).toBe(200);
    restoreResultSchema.parse(await response.json());
    expect(providerIds(h)).toEqual(['prov_original']);
  });

  it('refuses a file that was edited into something else', async () => {
    const h = await harness();
    seedProvider(h, 'prov_kept', 'Kept');
    const path = await exportToFile(h, 'edited.json');

    const archive = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const tampered = { ...archive, format: 99 };
    writeFileSync(path, JSON.stringify(tampered), 'utf8');

    const response = await restoreFromFile(h, path);

    expect(response.status).toBe(400);
    // Nothing was written: the refusal is before any statement runs.
    expect(providerIds(h)).toEqual(['prov_kept']);
  });
});

describe('telemetry in an archive', () => {
  it('carries requests and captures', async () => {
    const h = await harness();
    seedRequest(h, 'req_1', '2026-10-14T10:00:00.000Z');
    seedCapture(h, 'cap_1', 'req_1');

    const archive = archiveOf(await exportToFile(h, 'telemetry.json'));

    expect(archive.tables.requests).toHaveLength(1);
    expect(archive.tables.request_captures).toHaveLength(1);
    // The capture's own redacted body travels with it — it is already the result
    // of the scrubber, so there is nothing left to remove.
    expect(archive.tables.request_captures?.[0]?.redacted).toBe(0);
  });

  it('does not duplicate rows when a restore is applied twice', async () => {
    // The D2 item, and the reason it is "by construction": restore *replaces* the
    // tables it names rather than merging into them, so applying the same archive
    // twice leaves the same number of rows. A merge would double them, and the
    // operator would find out by watching a usage chart climb.
    const h = await harness();
    seedRequest(h, 'req_1', '2026-10-14T10:00:00.000Z');
    seedCapture(h, 'cap_1', 'req_1');
    const path = await exportToFile(h, 'twice.json');

    const first = await restoreFromFile(h, path);
    expect(first.status).toBe(200);
    const afterFirst = countIn(h, 'requests');

    const second = await restoreFromFile(h, path);
    expect(second.status).toBe(200);

    expect(afterFirst).toBe(1);
    expect(countIn(h, 'requests')).toBe(1);
    expect(countIn(h, 'request_captures')).toBe(1);
  });

  it('replaces this instance’s telemetry with the archive’s, rather than merging', async () => {
    // The other side of the same coin, and the part an operator should know: a
    // restore is not additive. Telemetry the archive does not have is gone.
    const h = await harness();
    seedRequest(h, 'req_archived', '2026-10-14T10:00:00.000Z');
    const path = await exportToFile(h, 'one-row.json');

    seedRequest(h, 'req_local', '2026-10-14T11:00:00.000Z');
    expect(countIn(h, 'requests')).toBe(2);

    const response = await restoreFromFile(h, path);
    expect(response.status).toBe(200);

    const ids = (
      h.server.persistence.sqlite.query('select id from requests').all() as { id: string }[]
    ).map((row) => row.id);
    expect(ids).toEqual(['req_archived']);
  });

  it('keeps the savings a restored request carried', async () => {
    // C14's column rides along like any other: a request that recorded what the
    // Token Saver removed still reports it after a restore, which is what makes
    // a savings chart survive a machine move.
    const h = await harness();
    h.server.persistence.sqlite
      .query(
        `insert into requests
           (id, at, method, path, status, latency_ms, input_tokens, token_saver_savings)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'req_savings',
        '2026-10-14T10:00:00.000Z',
        'POST',
        '/v1/chat/completions',
        200,
        120,
        1_000,
        JSON.stringify({
          tokensIn: 1_000,
          tokensOut: 750,
          tokensSaved: 250,
          stages: [{ stageId: 'tsc', bytesIn: 4_000, bytesOut: 3_000, tokensSaved: 250 }],
        }),
      );

    const path = await exportToFile(h, 'savings.json');
    h.server.persistence.sqlite.query('delete from requests').run();
    await restoreFromFile(h, path);

    const row = h.server.persistence.sqlite
      .query('select token_saver_savings as value from requests where id = ?')
      .get('req_savings') as { value: string | null };

    expect(row.value).not.toBeNull();
    const stored = JSON.parse(row.value ?? 'null') as { tokensSaved: number };
    expect(stored.tokensSaved).toBe(250);
  });
});
