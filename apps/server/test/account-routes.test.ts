import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_API_PREFIX,
  accountsResponseSchema,
  bulkResultSchema,
  consoleErrorSchema,
  consolePaths,
  okSchema,
  quotaOverviewSchema,
} from '@contracts';
import type { Account } from '@contracts';

import { buildApp } from '@server/app.ts';
import { SecretBox } from '@server/security/secret-box.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The account pool's console surface (FR-3, C5a-3).
 *
 * Route-level, over the real composition, because what is being checked is the
 * agreement between three layers that only meet here: the contract's query and
 * body schemas, the service's state-machine gate, and the pool's in-flight count
 * that the list reads instead of the column.
 *
 * The credential is asserted absent from every answer. It is the one field the
 * product stores write-only, and a route test is where "the read model never
 * returns it" is worth pinning.
 */

const PASSWORD = 'correct-horse-battery';
const KEY = 'ab'.repeat(32);

const ACCOUNTS_PATH = `${CONSOLE_API_PREFIX}${consolePaths.accounts}`;
const BULK_PATH = `${CONSOLE_API_PREFIX}${consolePaths.accountsBulk}`;
const QUOTA_PATH = `${CONSOLE_API_PREFIX}${consolePaths.quota}`;
const QUOTA_CHECK_PATH = `${CONSOLE_API_PREFIX}${consolePaths.quotaCheck}`;

type App = ReturnType<typeof buildApp>;

function accountPath(id: string): string {
  return `${CONSOLE_API_PREFIX}${consolePaths.account.replace(':id', id)}`;
}

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

interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly cookie?: string;
}

async function call(app: App, path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  return app.request(path, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function errorOf(response: Response): Promise<{ kind: string; message: string }> {
  return consoleErrorSchema.parse(await response.json()).error;
}

async function createAccount(app: App, cookie: string, body: unknown): Promise<Account> {
  const response = await call(app, ACCOUNTS_PATH, { method: 'POST', body, cookie });
  expect(response.status).toBe(201);
  return (await response.json()) as Account;
}

async function listAccounts(app: App, cookie: string, query = ''): Promise<Account[]> {
  const response = await call(app, `${ACCOUNTS_PATH}${query}`, { cookie });
  expect(response.status).toBe(200);
  return accountsResponseSchema.parse(await response.json()).items;
}

const INPUT = {
  providerId: 'openai',
  label: 'Primary',
  credential: 'sk-live-secret',
  email: 'operator@example.com',
};

let server: TestServer;
let app: App;
let cookie: string;

beforeEach(async () => {
  server = makeServer({ secrets: new SecretBox(KEY) });
  server.lifecycle.markReady();
  app = buildApp(server);
  cookie = await signIn(app);
});

afterEach(() => {
  server.close();
});

describe('the session guard', () => {
  it('refuses a listing without a session', async () => {
    const response = await call(app, ACCOUNTS_PATH);
    expect(response.status).toBe(401);
    expect((await errorOf(response)).kind).toBe('authentication');
  });
});

describe('listing', () => {
  it('answers an empty page on a fresh install', async () => {
    const response = await call(app, ACCOUNTS_PATH, { cookie });
    const body = accountsResponseSchema.parse(await response.json());

    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.nextCursor).toBeNull();
  });

  it('refuses a query the schema does not recognise', async () => {
    const response = await call(app, `${ACCOUNTS_PATH}?state=not-a-state`, { cookie });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).kind).toBe('invalid_request');
  });

  it('filters by provider and by state', async () => {
    await createAccount(app, cookie, INPUT);
    await createAccount(app, cookie, { ...INPUT, providerId: 'anthropic', label: 'Claude' });

    expect(await listAccounts(app, cookie, '?providerId=openai')).toHaveLength(1);
    expect(await listAccounts(app, cookie, '?providerId=anthropic')).toHaveLength(1);
    // A key pasted by hand has never been used, so it starts `pending`.
    expect(await listAccounts(app, cookie, '?state=pending')).toHaveLength(2);
    expect(await listAccounts(app, cookie, '?state=active')).toHaveLength(0);
  });

  it('searches the label', async () => {
    await createAccount(app, cookie, INPUT);
    await createAccount(app, cookie, { ...INPUT, label: 'Backup' });

    expect(await listAccounts(app, cookie, '?q=backup')).toHaveLength(1);
  });
});

describe('creating', () => {
  it('files a hand-added key as pending, awaiting its first use', async () => {
    const account = await createAccount(app, cookie, INPUT);

    expect(account.state).toBe('pending');
    expect(account.stateReason).toBe('Awaiting first use.');
    expect(account.providerId).toBe('openai');
    expect(account.maxInFlight).toBe(1);
    expect(account.inFlight).toBe(0);
  });

  it('never hands the credential back', async () => {
    const account = await createAccount(app, cookie, INPUT);

    // The read model has no field for it, so the assertion is that nothing in
    // the answer carries the secret the operator pasted.
    expect(JSON.stringify(account)).not.toContain('sk-live-secret');
    expect(account).not.toHaveProperty('credential');
    expect(account).not.toHaveProperty('credentialEnvelope');
  });

  it('masks the email rather than echoing it', async () => {
    const account = await createAccount(app, cookie, INPUT);

    expect(account.emailMasked).not.toBe(INPUT.email);
    expect(account.emailMasked).toContain('@example.com');
    expect(JSON.stringify(account)).not.toContain('operator@example.com');
  });

  it('refuses an unknown provider', async () => {
    const response = await call(app, ACCOUNTS_PATH, {
      method: 'POST',
      body: { ...INPUT, providerId: 'not-a-provider' },
      cookie,
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).kind).toBe('invalid_request');
  });

  it('refuses a body with no credential', async () => {
    const response = await call(app, ACCOUNTS_PATH, {
      method: 'POST',
      body: { providerId: 'openai', label: 'Primary' },
      cookie,
    });

    expect(response.status).toBe(400);
  });
});

describe('editing', () => {
  it('moves an account by hand', async () => {
    const account = await createAccount(app, cookie, INPUT);

    const response = await call(app, accountPath(account.id), {
      method: 'PATCH',
      body: { state: 'disabled' },
      cookie,
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Account).state).toBe('disabled');
  });

  it('refuses a move the state machine does not allow', async () => {
    const account = await createAccount(app, cookie, INPUT);

    // `pending` has never been used, so nothing could have rate-limited it.
    const response = await call(app, accountPath(account.id), {
      method: 'PATCH',
      body: { state: 'rate_limited' },
      cookie,
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).kind).toBe('invalid_request');
  });

  it('edits a label without touching the state', async () => {
    const account = await createAccount(app, cookie, INPUT);

    const response = await call(app, accountPath(account.id), {
      method: 'PATCH',
      body: { label: 'Renamed' },
      cookie,
    });

    const updated = (await response.json()) as Account;
    expect(updated.label).toBe('Renamed');
    expect(updated.state).toBe('pending');
  });

  it('404s for an account that is not there', async () => {
    const response = await call(app, accountPath('missing'), {
      method: 'PATCH',
      body: { label: 'x' },
      cookie,
    });

    expect(response.status).toBe(404);
    expect((await errorOf(response)).kind).toBe('not_found');
  });
});

describe('removing', () => {
  it('deletes an account and reports ok', async () => {
    const account = await createAccount(app, cookie, INPUT);

    const response = await call(app, accountPath(account.id), { method: 'DELETE', cookie });
    expect(response.status).toBe(200);
    expect(okSchema.parse(await response.json()).ok).toBe(true);

    expect(await listAccounts(app, cookie)).toHaveLength(0);
  });

  it('404s for an account that is not there', async () => {
    const response = await call(app, accountPath('missing'), { method: 'DELETE', cookie });
    expect(response.status).toBe(404);
  });
});

describe('bulk actions', () => {
  it('applies an action across the ids it was given', async () => {
    const first = await createAccount(app, cookie, INPUT);
    const second = await createAccount(app, cookie, { ...INPUT, label: 'Backup' });

    const response = await call(app, BULK_PATH, {
      method: 'POST',
      body: { ids: [first.id, second.id], action: 'disable' },
      cookie,
    });
    const result = bulkResultSchema.parse(await response.json());

    expect(result).toMatchObject({ requested: 2, succeeded: 2, failed: 0 });
    expect(await listAccounts(app, cookie, '?state=disabled')).toHaveLength(2);
  });

  it('acts on the ids it can and reports the ones it could not', async () => {
    const account = await createAccount(app, cookie, INPUT);

    const response = await call(app, BULK_PATH, {
      method: 'POST',
      body: { ids: [account.id, 'stale'], action: 'disable' },
      cookie,
    });
    const result = bulkResultSchema.parse(await response.json());

    // One row's refusal is that row's problem: the paste still acts on the rest.
    expect(result).toMatchObject({ requested: 2, succeeded: 1, failed: 1 });
    expect(result.errors[0]?.id).toBe('stale');
    expect(await listAccounts(app, cookie, '?state=disabled')).toHaveLength(1);
  });

  it('refuses an empty id list', async () => {
    const response = await call(app, BULK_PATH, {
      method: 'POST',
      body: { ids: [], action: 'disable' },
      cookie,
    });

    expect(response.status).toBe(400);
  });
});

describe('quota', () => {
  it('reports no rows when nothing is configured', async () => {
    const response = await call(app, QUOTA_PATH, { cookie });
    const body = quotaOverviewSchema.parse(await response.json());

    expect(body.rows).toEqual([]);
    // No sweep has been started in this test, so no next one is scheduled.
    expect(body.nextSweepInSeconds).toBeNull();
  });

  it('reports a row per provider that has an account, with no window yet', async () => {
    await createAccount(app, cookie, INPUT);

    const response = await call(app, QUOTA_PATH, { cookie });
    const body = quotaOverviewSchema.parse(await response.json());

    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.providerId).toBe('openai');
    // The account has never been probed, so there is no window to report.
    expect(body.rows[0]?.windows).toEqual([]);
    expect(body.rows[0]?.checking).toBe(false);
  });

  it('starts a check-in and reports it without waiting for the sweep', async () => {
    await createAccount(app, cookie, INPUT);

    const response = await call(app, QUOTA_CHECK_PATH, {
      method: 'POST',
      body: { providerIds: ['openai'] },
      cookie,
    });
    expect(response.status).toBe(200);

    const body = quotaOverviewSchema.parse(await response.json());
    // The sweep marks its target before its first await, so the answer that
    // comes back at once already knows the provider is being checked.
    expect(body.rows[0]?.providerId).toBe('openai');
  });

  it('accepts an empty body as “every provider”', async () => {
    const response = await call(app, QUOTA_CHECK_PATH, { method: 'POST', body: {}, cookie });
    expect(response.status).toBe(200);
  });
});
