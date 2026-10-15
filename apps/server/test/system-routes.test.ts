import { afterEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_API_PREFIX,
  backupArchiveSchema,
  backupManifestSchema,
  consoleErrorSchema,
  consolePaths,
  customizationSchema,
  generalSettingsSchema,
  restoreResultSchema,
} from '@contracts';
import type { BackupArchive } from '@contracts';

import { buildApp } from '@server/app.ts';
import { currentSchemaVersion } from '@server/persistence/migrate.ts';
import { createBackupService, REDACTED } from '@server/system/backup.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * Exporting the instance and putting it back (C13b, SEC-6).
 *
 * A real composition, driven through the console's own routes. What these assert
 * is what an operator can observe: the archive they download, the file they
 * upload, and what the instance looks like afterwards.
 *
 * Four rules carry the section, and each has its own group below because each
 * exists to prevent a specific way of losing data:
 *
 *   - **The password and the live sessions never leave.** An archive that carried
 *     a password would be a file that can lock an operator out of the instance it
 *     was taken from, with no way back but editing SQLite by hand.
 *   - **A restore replaces, in one transaction, and refuses a newer schema.** A
 *     merge would produce a mixture of two instances that never existed; a
 *     half-written database is worse than a refused one.
 *   - **Every identifier is checked against the live schema.** A table name comes
 *     from an uploaded file, so an archive that names a table rutekit does not
 *     have — or a column it does not have — is refused rather than believed.
 *   - **Credentials leave only when asked, and as ciphertext.** The default is
 *     off, because the export that quietly carried every key would be the single
 *     most damaging file the instance can produce.
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

async function call(
  app: App,
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  return app.request(path, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

const CUSTOMIZATION = `${CONSOLE_API_PREFIX}${consolePaths.customization}`;
const GENERAL = `${CONSOLE_API_PREFIX}${consolePaths.generalSettings}`;
const MANIFEST = `${CONSOLE_API_PREFIX}${consolePaths.backupManifest}`;
const BACKUP = `${CONSOLE_API_PREFIX}${consolePaths.backup}`;
const RESTORE = `${CONSOLE_API_PREFIX}${consolePaths.restore}`;

async function errorOf(response: Response): Promise<{ kind: string; message: string }> {
  return consoleErrorSchema.parse(await response.json()).error;
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

/** An account, so the credential columns have something real in them. */
function addAccount(h: Harness, id = 'acct_1'): void {
  h.server.persistence.sqlite
    .query(
      `insert into provider_accounts
         (id, provider_id, label, credential_envelope, auth_mode, state, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      'openai',
      'Primary',
      'v1.envelope.ciphertext',
      'api_key',
      'active',
      '2026-01-01',
      '2026-01-01',
    );
}

function addProvider(h: Harness, id = 'prov_1', name = 'My Endpoint'): void {
  h.server.persistence.sqlite
    .query(
      `insert into providers (id, name, category, wire_family, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, name, 'byok', 'openai', '2026-01-01', '2026-01-01');
}

function accountCount(h: Harness): number {
  const row = h.server.persistence.sqlite
    .query('select count(*) as n from provider_accounts')
    .get() as { n: number };
  return row.n;
}

function envelopeOf(h: Harness, id = 'acct_1'): string | null {
  const row = h.server.persistence.sqlite
    .query('select credential_envelope as value from provider_accounts where id = ?')
    .get(id) as { value: string } | null;
  return row?.value ?? null;
}

/** Export through the route and read the archive back off the response body. */
async function exportArchive(h: Harness, includeCredentials = false): Promise<BackupArchive> {
  const response = await call(h.app, BACKUP, {
    method: 'POST',
    cookie: h.cookie,
    body: { includeCredentials },
  });
  expect(response.status).toBe(200);
  return backupArchiveSchema.parse(await response.json());
}

/** Put an archive back the way the console does: base64 in a JSON body. */
async function restoreArchive(h: Harness, archive: unknown): Promise<Response> {
  return call(h.app, RESTORE, {
    method: 'POST',
    cookie: h.cookie,
    body: {
      archive: Buffer.from(JSON.stringify(archive), 'utf8').toString('base64'),
      confirm: true,
    },
  });
}

/* ---- What leaves ---- */

describe('an export', () => {
  it('carries the instance and names what it left out', async () => {
    const h = await harness();
    addProvider(h);
    addAccount(h);

    const archive = await exportArchive(h);

    expect(archive.format).toBe(1);
    expect(archive.schemaVersion).toBe(currentSchemaVersion(h.server.persistence.sqlite));
    expect(archive.includesCredentials).toBe(false);
    expect(archive.tables.providers).toHaveLength(1);
    expect(archive.tables.provider_accounts).toHaveLength(1);

    // The three tables that never travel, named rather than silently absent — an
    // archive that quietly lacked the password would be a file that claims to be
    // complete, and the next person to open it would have to read the code to
    // find out it is not.
    const omitted = archive.omitted.map((entry) => entry.table);
    expect(omitted).toContain('auth_credential');
    expect(omitted).toContain('sessions');
    expect(omitted).toContain('app_meta');
    for (const table of omitted) {
      expect(Object.hasOwn(archive.tables, table)).toBe(false);
    }
  });

  it('leaves credentials out by default, as a marker rather than a missing key', async () => {
    const h = await harness();
    addAccount(h);

    const archive = await exportArchive(h, false);

    const row = archive.tables.provider_accounts?.[0];
    // Present but redacted: a restore reads the archive back into the same
    // columns, and a missing key would be a column it has to guess about.
    expect(row?.credential_envelope).toBe(REDACTED);
    expect(row?.label).toBe('Primary');
  });

  it('carries the ciphertext when asked, and never the plaintext', async () => {
    const h = await harness();
    addAccount(h);

    const archive = await exportArchive(h, true);

    expect(archive.includesCredentials).toBe(true);
    // The envelope as stored — already encrypted by the `SecretBox` — so the file
    // is only readable by an instance holding the same key.
    expect(archive.tables.provider_accounts?.[0]?.credential_envelope).toBe(
      'v1.envelope.ciphertext',
    );
  });

  it('offers the archive as a download and still answers with a JSON body', async () => {
    const h = await harness();

    const response = await call(h.app, BACKUP, {
      method: 'POST',
      cookie: h.cookie,
      body: { includeCredentials: false },
    });

    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    // Dated, because the point of an export is that it is a copy taken at a
    // moment — a directory of identically-named files says nothing about which
    // is which.
    expect(response.headers.get('content-disposition')).toMatch(
      /rutekit-backup-\d{4}-\d{2}-\d{2}\.json/,
    );
    expect(backupArchiveSchema.safeParse(await response.json()).success).toBe(true);
  });

  it('defaults includeCredentials to false when the body omits it', async () => {
    const h = await harness();
    addAccount(h);

    const response = await call(h.app, BACKUP, { method: 'POST', cookie: h.cookie, body: {} });
    const archive = backupArchiveSchema.parse(await response.json());

    expect(archive.includesCredentials).toBe(false);
    expect(archive.tables.provider_accounts?.[0]?.credential_envelope).toBe(REDACTED);
  });
});

/* ---- What comes back ---- */

describe('a restore', () => {
  it('round-trips the instance', async () => {
    const h = await harness();
    addProvider(h, 'prov_original');
    addAccount(h, 'acct_original');

    const archive = await exportArchive(h);

    // Wipe the instance the way a restore would find it: something else entirely.
    h.server.persistence.sqlite.query('delete from provider_accounts').run();
    h.server.persistence.sqlite.query('delete from providers').run();
    addProvider(h, 'prov_replacement');

    const response = await restoreArchive(h, archive);
    expect(response.status).toBe(200);

    const result = restoreResultSchema.parse(await response.json());
    expect(result.ok).toBe(true);
    expect(result.tables).toBeGreaterThan(0);
    expect(result.rows).toBeGreaterThan(0);

    // The original is back and the replacement is gone, which is what "replace"
    // means — a merge would have left both, describing an instance that never was.
    const providers = h.server.persistence.sqlite.query('select id from providers').all() as {
      id: string;
    }[];
    expect(providers.map((row) => row.id)).toEqual(['prov_original']);
    expect(accountCount(h)).toBe(1);
  });

  it('carries a value in a nullable column, not just a NOT NULL one', async () => {
    const h = await harness();
    addProvider(h);
    // A nullable column with something in it. This is the half of the binding
    // bug that fails *silently*: a NOT NULL column throws when its value goes
    // missing, but a nullable one just stores NULL and the archive quietly loses
    // data on the way back in.
    h.server.persistence.sqlite
      .query('update providers set base_url = ?, description = ? where id = ?')
      .run('https://endpoint.example.test/v1', 'A self-hosted proxy.', 'prov_1');

    const archive = await exportArchive(h);
    expect(archive.tables.providers?.[0]?.base_url).toBe('https://endpoint.example.test/v1');

    h.server.persistence.sqlite.query('update providers set base_url = null').run();
    const response = await restoreArchive(h, archive);
    expect(response.status).toBe(200);

    const row = h.server.persistence.sqlite
      .query('select base_url, description, free_tier from providers where id = ?')
      .get('prov_1') as { base_url: string; description: string; free_tier: number };
    expect(row.base_url).toBe('https://endpoint.example.test/v1');
    expect(row.description).toBe('A self-hosted proxy.');
    // And a boolean column, which SQLite stores as an integer.
    expect(row.free_tier).toBe(0);
  });

  it('reports the tables it did not touch rather than silently leaving them', async () => {
    const h = await harness();
    addProvider(h);

    const archive = await exportArchive(h);
    // A legitimate archive from a build that had fewer tables.
    const trimmed = { ...archive, tables: { providers: archive.tables.providers ?? [] } };

    const result = restoreResultSchema.parse(await (await restoreArchive(h, trimmed)).json());

    expect(result.untouched).toContain('provider_accounts');
    expect(result.untouched).toContain('api_keys');
    // An untouched table is reported, not replaced with nothing.
    expect(result.tables).toBe(1);
  });

  it('restores the redacted credentials as they were stored', async () => {
    const h = await harness();
    addAccount(h);

    const archive = await exportArchive(h, false);
    const response = await restoreArchive(h, archive);

    expect(response.status).toBe(200);
    // The marker lands where the envelope was, which is the honest outcome: the
    // archive genuinely does not contain the credential, and a restore that
    // invented one would be worse than one that says so.
    expect(envelopeOf(h)).toBe(REDACTED);
  });

  it('refuses an archive from a newer schema, and changes nothing', async () => {
    const h = await harness();
    addProvider(h, 'prov_kept');

    const archive = await exportArchive(h);
    const fromTheFuture = {
      ...archive,
      schemaVersion: currentSchemaVersion(h.server.persistence.sqlite) + 1,
      tables: { providers: [] },
    };

    const response = await restoreArchive(h, fromTheFuture);

    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.kind).toBe('invalid_request');
    expect(error.message).toContain('Upgrade rutekit');

    // The refusal is before anything is written, so the instance is exactly as it
    // was — an older build does not know what a newer column means, and a row
    // written without it is a row that lies.
    const providers = h.server.persistence.sqlite.query('select id from providers').all() as {
      id: string;
    }[];
    expect(providers.map((row) => row.id)).toEqual(['prov_kept']);
  });

  it('refuses a body that is not a rutekit backup', async () => {
    const h = await harness();

    const notJson = await call(h.app, RESTORE, {
      method: 'POST',
      cookie: h.cookie,
      body: { archive: Buffer.from('this is not json', 'utf8').toString('base64'), confirm: true },
    });
    expect(notJson.status).toBe(400);
    expect((await errorOf(notJson)).message).toContain('not a rutekit backup');

    const wrongShape = await call(h.app, RESTORE, {
      method: 'POST',
      cookie: h.cookie,
      body: { archive: Buffer.from('{"hello":"world"}', 'utf8').toString('base64'), confirm: true },
    });
    expect(wrongShape.status).toBe(400);
  });

  it('requires the confirmation flag', async () => {
    const h = await harness();
    const archive = await exportArchive(h);

    const response = await call(h.app, RESTORE, {
      method: 'POST',
      cookie: h.cookie,
      body: {
        archive: Buffer.from(JSON.stringify(archive), 'utf8').toString('base64'),
        confirm: false,
      },
    });

    expect(response.status).toBe(400);
  });
});

/* ---- What an archive is not allowed to say ---- */

describe('identifier safety', () => {
  it('skips a table rutekit does not restore', async () => {
    const h = await harness();
    const archive = await exportArchive(h);

    const withExtra = {
      ...archive,
      tables: { ...archive.tables, not_a_table: [{ id: 'x' }] },
    };

    const result = restoreResultSchema.parse(await (await restoreArchive(h, withExtra)).json());

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.table).toBe('not_a_table');
    expect(result.skipped[0]?.reason).toContain('does not restore');
  });

  it('skips a table whose name is SQL rather than an identifier', async () => {
    const h = await harness();
    addProvider(h, 'prov_kept');
    const archive = await exportArchive(h);

    // The name never reaches a statement: it is looked up in the known set first,
    // so a crafted archive cannot name a table rutekit does not have.
    const hostile = {
      ...archive,
      tables: { 'providers"; drop table providers; --': [{ id: 'x' }] },
    };

    const result = restoreResultSchema.parse(await (await restoreArchive(h, hostile)).json());

    expect(result.skipped[0]?.table).toBe('providers"; drop table providers; --');
    // And the table it tried to drop is still there.
    const providers = h.server.persistence.sqlite.query('select id from providers').all() as {
      id: string;
    }[];
    expect(providers.map((row) => row.id)).toEqual(['prov_kept']);
  });

  it('skips a table carrying a column this instance does not have', async () => {
    const h = await harness();
    addProvider(h, 'prov_kept');
    const archive = await exportArchive(h);

    const fromTheFuture = {
      ...archive,
      tables: { providers: [{ id: 'prov_new', a_column_from_v16: 'x' }] },
    };

    const result = restoreResultSchema.parse(await (await restoreArchive(h, fromTheFuture)).json());

    expect(result.skipped[0]?.table).toBe('providers');
    expect(result.skipped[0]?.reason).toContain('a_column_from_v16');

    // Refused rather than written with the columns it does recognise: a row
    // written without a column it needs is a row that lies about itself.
    const providers = h.server.persistence.sqlite.query('select id from providers').all() as {
      id: string;
    }[];
    expect(providers.map((row) => row.id)).toEqual(['prov_kept']);
  });

  it('binds every value rather than interpolating it', async () => {
    const h = await harness();
    const archive = await exportArchive(h);

    const hostile = {
      ...archive,
      tables: {
        providers: [
          {
            id: "x'); drop table providers; --",
            name: 'Robert"); drop table providers; --',
            category: 'byok',
            wire_family: 'openai',
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
          },
        ],
      },
    };

    const response = await restoreArchive(h, hostile);
    expect(response.status).toBe(200);

    // The value round-trips as a value — the statement never saw it as SQL.
    const row = h.server.persistence.sqlite
      .query('select name from providers where id = ?')
      .get("x'); drop table providers; --") as { name: string } | null;
    expect(row?.name).toBe('Robert"); drop table providers; --');

    // And the table the payload tried to drop still answers.
    const providers = h.server.persistence.sqlite
      .query('select count(*) as n from providers')
      .get() as {
      n: number;
    };
    expect(providers.n).toBe(1);
  });

  it('leaves a table alone when the archive does not mention it at all', async () => {
    const h = await harness();
    addAccount(h, 'acct_kept');
    const archive = await exportArchive(h);

    // `provider_accounts` is absent from the archive entirely, which is not the
    // same as present-and-empty: a restore only replaces what it was given.
    const withoutAccounts = {
      ...archive,
      tables: Object.fromEntries(
        Object.entries(archive.tables).filter(([table]) => table !== 'provider_accounts'),
      ),
    };

    const result = restoreResultSchema.parse(
      await (await restoreArchive(h, withoutAccounts)).json(),
    );

    expect(result.untouched).toContain('provider_accounts');
    expect(envelopeOf(h, 'acct_kept')).not.toBeNull();
  });

  it('replaces a table the archive names with an empty list', async () => {
    const h = await harness();
    addAccount(h, 'acct_doomed');
    const archive = await exportArchive(h);

    const emptied = { ...archive, tables: { ...archive.tables, provider_accounts: [] } };

    const response = await restoreArchive(h, emptied);
    expect(response.status).toBe(200);
    // Named and empty is a decision — "this instance has no accounts" — and a
    // restore that treated it as "no opinion" would leave the old rows behind.
    expect(accountCount(h)).toBe(0);
  });
});

/* ---- The manifest ---- */

describe('the backup manifest', () => {
  it('reports what a backup would carry, and claims no credentials it would not', async () => {
    const h = await harness();
    addProvider(h);
    addAccount(h);

    const manifest = backupManifestSchema.parse(
      await (await call(h.app, MANIFEST, { cookie: h.cookie })).json(),
    );

    expect(manifest.includesCredentials).toBe(false);
    expect(manifest.tableCounts.providers).toBe(1);
    expect(manifest.tableCounts.provider_accounts).toBe(1);
    // The manifest describes the *default* backup, so it does not claim the
    // credential columns an opt-in export would carry.
    expect(Object.hasOwn(manifest.tableCounts, 'auth_credential')).toBe(false);
    expect(Object.hasOwn(manifest.tableCounts, 'sessions')).toBe(false);
  });
});

/* ---- Appearance and general settings ---- */

describe('the settings records', () => {
  it('merges a patch rather than replacing the record', async () => {
    const h = await harness();

    const first = customizationSchema.parse(
      await (
        await call(h.app, CUSTOMIZATION, {
          method: 'PATCH',
          cookie: h.cookie,
          body: { glassDepth: 3 },
        })
      ).json(),
    );
    expect(first.glassDepth).toBe(3);

    // The fields the patch did not name are still there. A PATCH that reset them
    // would mean a form that forgot a field erases it.
    const second = customizationSchema.parse(
      await (
        await call(h.app, CUSTOMIZATION, {
          method: 'PATCH',
          cookie: h.cookie,
          body: { ambientGlow: false },
        })
      ).json(),
    );
    expect(second.glassDepth).toBe(3);
    expect(second.ambientGlow).toBe(false);
    expect(second.theme).toBe(first.theme);
    expect(second.backgroundOpacity).toBe(first.backgroundOpacity);
  });

  it('does not let an explicit undefined blank a field', async () => {
    const h = await harness();

    await call(h.app, GENERAL, {
      method: 'PATCH',
      cookie: h.cookie,
      body: { instanceName: 'named' },
    });
    const patched = generalSettingsSchema.parse(
      await (
        await call(h.app, GENERAL, {
          method: 'PATCH',
          cookie: h.cookie,
          body: { lowStressMode: true },
        })
      ).json(),
    );

    expect(patched.instanceName).toBe('named');
    expect(patched.lowStressMode).toBe(true);
  });

  it('refuses a value outside the contract', async () => {
    const h = await harness();

    const bad = await call(h.app, CUSTOMIZATION, {
      method: 'PATCH',
      cookie: h.cookie,
      body: { theme: 'midnight' },
    });

    expect(bad.status).toBe(400);
  });

  it('reads back the defaults before anything has been written', async () => {
    const h = await harness();

    const customization = customizationSchema.parse(
      await (await call(h.app, CUSTOMIZATION, { cookie: h.cookie })).json(),
    );
    const general = generalSettingsSchema.parse(
      await (await call(h.app, GENERAL, { cookie: h.cookie })).json(),
    );

    // The page an operator first sees and the values they first get are the same
    // configuration, so a fresh install does not render one way and then snap to
    // another the first time something is saved.
    expect(customization.theme).toBe('system');
    expect(customization.glassEnabled).toBe(true);
    expect(general.logLevel).toBe('info');
  });

  it('answers with the defaults rather than failing when the row is unreadable', async () => {
    const h = await harness();
    h.server.persistence.sqlite
      .query('insert into app_meta (key, value, updated_at) values (?, ?, ?)')
      .run('settings.customization', 'not json at all', '2026-01-01');

    const response = await call(h.app, CUSTOMIZATION, { cookie: h.cookie });

    // Fail-open: an unreadable appearance row must not be the reason a page
    // fails to render.
    expect(response.status).toBe(200);
    expect(customizationSchema.parse(await response.json()).theme).toBe('system');
  });
});

/* ---- The service, directly ---- */

describe('the backup service', () => {
  it('skips a restorable table this build has not created', async () => {
    const h = await harness();
    h.server.persistence.sqlite.query('drop table request_captures').run();

    const service = createBackupService({
      persistence: h.server.persistence,
      logger: h.server.logger,
    });

    // An older instance exporting what it has is a legitimate archive, so a table
    // a migration has not created yet is skipped rather than fatal.
    const archive = service.export({ includeCredentials: false });
    expect(Object.hasOwn(archive.tables, 'request_captures')).toBe(false);
    expect(Object.hasOwn(archive.tables, 'providers')).toBe(true);
  });
});
