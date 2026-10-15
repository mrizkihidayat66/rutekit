import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_API_PREFIX,
  consoleErrorSchema,
  consoleMetaSchema,
  consolePaths,
  openAiErrorSchema,
} from '@contracts';

import { buildApp } from '@server/app.ts';
import { migrations } from '@server/persistence/migrations/index.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The composition root, end to end (C1.6, extended in C2.5).
 *
 * These go through `buildApp` and Hono's own `app.request`, so they exercise the
 * real stage order — request id, abuse counter, body policy, readiness gate, and
 * now the two doors — and not a re-creation of it. The database is real (in
 * memory); nothing else reaches outside the process.
 *
 * The two doors are the reason this file changed when C2 landed: a console route
 * reached without a session is a 401, and `/v1` without a key is a 401, so a test
 * that wants to see the route behind them has to open them the way a caller does.
 */

const META_PATH = `${CONSOLE_API_PREFIX}${consolePaths.meta}`;
const SETUP_PATH = `${CONSOLE_API_PREFIX}${consolePaths.authSetup}`;
const PASSWORD = 'correct-horse-battery';

/**
 * `Response.json()` is typed `unknown` here (Bun's `Response`, and the server's
 * tsconfig carries no DOM lib), so a test names the shape it expects at the
 * point it reads one.
 */
async function jsonOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** The refusal, read through the contract's envelope rather than cast. */
async function errorOf(response: Response): Promise<{ kind: string; requestId: string | null }> {
  return consoleErrorSchema.parse(await response.json()).error;
}

/**
 * The same, for the data plane.
 *
 * `/v1` answers in the OpenAI envelope so the SDK on the other side can parse it,
 * which puts the reason in `type` instead of `kind`. This file asserts the
 * dialect switch as well as the reason, so it reads the envelope the namespace
 * actually owns rather than the console's.
 */
async function v1ErrorOf(response: Response): Promise<{ kind: string; message: string }> {
  const { error } = openAiErrorSchema.parse(await response.json());
  return { kind: error.type, message: error.message };
}

/**
 * Create the instance's password and return the cookie header to replay.
 *
 * Through the real setup route, not by reaching into the service: the point of
 * this file is the composition, and the composition is what mints the cookie.
 */
async function signIn(app: ReturnType<typeof buildApp>): Promise<string> {
  const response = await app.request(SETUP_PATH, {
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

let server: TestServer;

beforeEach(() => {
  server = makeServer();
});

afterEach(() => {
  server.close();
});

describe('the probes', () => {
  it('answers /healthz even before the process is ready', async () => {
    const app = buildApp(server);

    const response = await app.request('/healthz');

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: 'ok', state: 'starting', connections: 0 });
  });

  it('refuses /readyz until the process is ready', async () => {
    const app = buildApp(server);

    const starting = await app.request('/readyz');
    expect(starting.status).toBe(503);
    expect(starting.headers.get('retry-after')).toBe('1');
    expect((await jsonOf<{ status: string }>(starting)).status).toBe('not_ready');

    server.lifecycle.markReady();

    const ready = await app.request('/readyz');
    expect(ready.status).toBe(200);
    const body = await ready.json();
    expect(body).toMatchObject({ status: 'ready', checks: { database: 'up' } });
  });
});

describe('the console namespace', () => {
  it('serves meta from the real store once a session is open', async () => {
    server.lifecycle.markReady();
    const app = buildApp(server);
    const cookie = await signIn(app);

    const response = await app.request(META_PATH, { headers: { cookie } });
    expect(response.status).toBe(200);

    const body = await response.json();
    // The contract is the authority on the shape; this is a real parse, not a
    // spot-check of two fields.
    const meta = consoleMetaSchema.parse(body);
    expect(meta.name).toBe('rutekit');
    // The route reports the version the database is actually at, so the honest
    // expectation is the shipped list's own length rather than a fixed number.
    expect(meta.schemaVersion).toBe(migrations.length);
    expect(meta.database).toEqual({ driver: 'sqlite', inMemory: true });
  });

  it('refuses a console route without a session', async () => {
    server.lifecycle.markReady();
    const app = buildApp(server);

    const response = await app.request(META_PATH);

    expect(response.status).toBe(401);
    expect((await errorOf(response)).kind).toBe('authentication');
  });

  it('carries a request id into the error envelope', async () => {
    server.lifecycle.markReady();
    const app = buildApp(server);
    const cookie = await signIn(app);

    const response = await app.request(`${CONSOLE_API_PREFIX}/nope`, { headers: { cookie } });
    expect(response.status).toBe(404);

    const raw = await response.text();
    expect(raw).not.toContain('stack');

    const error = consoleErrorSchema.parse(JSON.parse(raw)).error;
    expect(error.kind).toBe('not_found');
    expect(error.requestId).toBeTypeOf('string');
    expect(error.requestId).not.toBe('');
  });
});

describe('the /v1 namespace', () => {
  it('refuses a request with no key', async () => {
    server.lifecycle.markReady();
    const app = buildApp(server);

    const response = await app.request('/v1/chat/completions', { method: 'POST' });

    expect(response.status).toBe(401);
    expect((await v1ErrorOf(response)).kind).toBe('authentication');
  });

  it('answers in the data plane dialect, not the console one, once a key is presented', async () => {
    server.lifecycle.markReady();
    const app = buildApp(server);
    const { secret } = server.apiKeys.create({
      name: 'probe',
      modelsAllowed: [],
      modelsDenied: [],
      budgetRequests: null,
      budgetTokens: null,
      tpsLimit: null,
      rateLimitPerMinute: null,
      expiresAt: null,
      clientRouterDenylist: [],
    });

    // No `model` in the body, so the route refuses it — and the refusal has to be
    // readable by the SDK on the other side. The console's `{ kind, requestId }`
    // envelope would be a parse failure there, which is the whole reason the
    // error handler switches dialect on the path.
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
    });

    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    expect(openAiErrorSchema.safeParse(body).success).toBe(true);
    expect(consoleErrorSchema.safeParse(body).success).toBe(false);
  });
});

describe('during a drain', () => {
  it('refuses new console and /v1 work with shutting_down', async () => {
    server.lifecycle.markReady();
    const app = buildApp(server);
    server.lifecycle.beginDrain();

    const meta = await app.request(META_PATH);
    expect(meta.status).toBe(503);
    expect(meta.headers.get('retry-after')).toBe('1');
    expect((await errorOf(meta)).kind).toBe('shutting_down');

    const dataPlane = await app.request('/v1/chat/completions', { method: 'POST' });
    expect(dataPlane.status).toBe(503);
    expect((await v1ErrorOf(dataPlane)).kind).toBe('shutting_down');
  });

  it('still answers the probes, so the reason is reportable', async () => {
    server.lifecycle.markReady();
    const app = buildApp(server);
    server.lifecycle.beginDrain();

    // /healthz stays 200: a supervisor that restarts a draining process kills
    // the requests it was politely finishing.
    expect((await app.request('/healthz')).status).toBe(200);

    // /readyz turns 503: stop routing here, but do not restart me.
    const readyz = await app.request('/readyz');
    expect(readyz.status).toBe(503);
    expect(readyz.headers.get('retry-after')).toBe('1');
  });
});
