import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_API_PREFIX,
  apiKeyCreatedSchema,
  apiKeySchema,
  apiKeysResponseSchema,
  consoleErrorSchema,
  consolePaths,
  okSchema,
  openAiErrorSchema,
} from '@contracts';
import type { ApiKey } from '@contracts';

import { buildApp } from '@server/app.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The API-key console and the data-plane guard (FR-6, C2.4).
 *
 * Two halves, one file, because they are one feature: the console mints a key
 * and the guard is the only thing that spends it. A key created here is presented
 * to `/v1` in the same test, so "the console and the guard agree about what a
 * live key is" is asserted rather than assumed — the derivation is shared, and
 * this is where that claim is checked.
 */

const PASSWORD = 'correct-horse-battery';
const KEYS_PATH = `${CONSOLE_API_PREFIX}${consolePaths.apiKeys}`;

type App = ReturnType<typeof buildApp>;

function keyPath(id: string): string {
  return `${CONSOLE_API_PREFIX}${consolePaths.apiKey.replace(':id', id)}`;
}

function revokePath(id: string): string {
  return `${CONSOLE_API_PREFIX}${consolePaths.apiKeyRevoke.replace(':id', id)}`;
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
  readonly authorization?: string;
}

async function call(app: App, path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  if (options.authorization !== undefined) headers.authorization = options.authorization;
  return app.request(path, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

/**
 * The refusal, read through the contract's envelope.
 *
 * Parsing rather than reading `.error` off the raw body does two jobs: it gets
 * past `Response.json()` being `unknown`, and it asserts that a refusal came
 * back in the shape a client is written against.
 */
async function errorOf(response: Response): Promise<{ kind: string; message: string }> {
  return consoleErrorSchema.parse(await response.json()).error;
}

/**
 * The refusal as the data plane renders it.
 *
 * `/v1` is not the console, so it answers in the OpenAI envelope — the shape an
 * SDK on the other side is written against — and the reason lands in `type`
 * rather than `kind`. The two carry the same `ErrorKind`; this renames it so a
 * test can name a reason without caring which namespace it came from.
 */
async function v1ErrorOf(response: Response): Promise<{ kind: string; message: string }> {
  const { error } = openAiErrorSchema.parse(await response.json());
  return { kind: error.type, message: error.message };
}

/** Create a key through the console route, the way the page does. */
async function createKey(app: App, cookie: string, body: unknown): Promise<ApiKey> {
  const response = await call(app, KEYS_PATH, { method: 'POST', body, cookie });
  expect(response.status).toBe(201);
  return apiKeyCreatedSchema.parse(await response.json()).apiKey;
}

/** Mint a key and hand back both the row and the one-time secret. */
async function mintKey(
  app: App,
  cookie: string,
  body: unknown,
): Promise<{ apiKey: ApiKey; secret: string }> {
  const response = await call(app, KEYS_PATH, { method: 'POST', body, cookie });
  expect(response.status).toBe(201);
  return apiKeyCreatedSchema.parse(await response.json());
}

/**
 * Present a secret to the data plane.
 *
 * The body is empty on purpose. The guard runs ahead of the route, so a refusal
 * is a 401 or a 429, and an admission shows up as the route's own
 * `invalid_request` for a body with no `model` in it — that is the pass signal,
 * and it is a stronger one than a status coincidence because only a request the
 * guard admitted ever reaches the dispatcher to be told its body is wrong.
 */
function present(app: App, secret: string): Promise<Response> {
  return call(app, '/v1/chat/completions', {
    method: 'POST',
    body: {},
    authorization: `Bearer ${secret}`,
  });
}

let server: TestServer;
let app: App;
let cookie: string;

beforeEach(async () => {
  server = makeServer();
  server.lifecycle.markReady();
  app = buildApp(server);
  cookie = await signIn(app);
});

afterEach(() => {
  server.close();
});

describe('the api-key console', () => {
  it('starts empty', async () => {
    const response = await call(app, KEYS_PATH, { cookie });

    expect(response.status).toBe(200);
    const page = apiKeysResponseSchema.parse(await response.json());
    expect(page).toEqual({ items: [], nextCursor: null, total: 0 });
  });

  it('creates a key, showing the secret exactly once', async () => {
    const response = await call(app, KEYS_PATH, {
      method: 'POST',
      body: { name: 'laptop' },
      cookie,
    });
    expect(response.status).toBe(201);

    const created = apiKeyCreatedSchema.parse(await response.json());
    expect(created.secret.startsWith('rk-')).toBe(true);
    expect(created.apiKey.prefix).toBe(created.secret.slice(0, 7));

    // The list — the only way to read a key back — has no secret in it.
    const page = apiKeysResponseSchema.parse(
      await (await call(app, KEYS_PATH, { cookie })).json(),
    );
    expect(page.items).toHaveLength(1);
    expect(Object.keys(page.items[0] ?? {})).not.toContain('secret');
  });

  it('refuses a key with no name', async () => {
    const response = await call(app, KEYS_PATH, { method: 'POST', body: {}, cookie });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).kind).toBe('invalid_request');
  });

  it('narrows the list by search text and by state', async () => {
    await createKey(app, cookie, { name: 'laptop' });
    const phone = await createKey(app, cookie, { name: 'phone' });
    await call(app, revokePath(phone.id), { method: 'POST', cookie });

    const searched = apiKeysResponseSchema.parse(
      await (await call(app, `${KEYS_PATH}?q=lap`, { cookie })).json(),
    );
    expect(searched.items.map((item) => item.name)).toEqual(['laptop']);

    const revoked = apiKeysResponseSchema.parse(
      await (await call(app, `${KEYS_PATH}?state=revoked`, { cookie })).json(),
    );
    expect(revoked.items.map((item) => item.name)).toEqual(['phone']);

    const active = apiKeysResponseSchema.parse(
      await (await call(app, `${KEYS_PATH}?state=active`, { cookie })).json(),
    );
    expect(active.items.map((item) => item.name)).toEqual(['laptop']);
  });

  it('updates only the fields the console sent', async () => {
    const key = await createKey(app, cookie, {
      name: 'laptop',
      modelsAllowed: ['gpt-4o'],
      tpsLimit: 5,
      budgetRequests: 100,
    });

    const patched = await call(app, keyPath(key.id), {
      method: 'PATCH',
      body: { name: 'workstation' },
      cookie,
    });
    expect(patched.status).toBe(200);

    const updated = apiKeySchema.parse(await patched.json());
    expect(updated.name).toBe('workstation');
    // The fields the patch did not mention must survive it. A `partial()` schema
    // with defaults would have reset every one of these.
    expect(updated.modelsAllowed).toEqual(['gpt-4o']);
    expect(updated.tpsLimit).toBe(5);
    expect(updated.budgetRequests).toBe(100);
    expect(updated.revokedAt).toBeNull();
  });

  it('clears a ceiling when the console sends null for it', async () => {
    const key = await createKey(app, cookie, { name: 'laptop', budgetRequests: 100 });

    const patched = await call(app, keyPath(key.id), {
      method: 'PATCH',
      body: { budgetRequests: null },
      cookie,
    });
    expect(patched.status).toBe(200);
    expect(apiKeySchema.parse(await patched.json()).budgetRequests).toBeNull();
  });

  it('revokes a key, and the state is derived rather than stored twice', async () => {
    const key = await createKey(app, cookie, { name: 'laptop' });
    expect(key.revokedAt).toBeNull();

    const response = await call(app, revokePath(key.id), { method: 'POST', cookie });
    expect(response.status).toBe(200);
    expect(apiKeySchema.parse(await response.json()).revokedAt).not.toBeNull();
  });

  it('deletes a key', async () => {
    const key = await createKey(app, cookie, { name: 'laptop' });

    const removed = await call(app, keyPath(key.id), { method: 'DELETE', cookie });
    expect(removed.status).toBe(200);
    expect(okSchema.parse(await removed.json())).toEqual({ ok: true });

    const page = apiKeysResponseSchema.parse(
      await (await call(app, KEYS_PATH, { cookie })).json(),
    );
    expect(page.items).toHaveLength(0);
  });

  it('answers not_found for an id that does not exist', async () => {
    const attempts = [
      { method: 'PATCH', body: { name: 'x' }, path: keyPath('missing') },
      { method: 'POST', body: undefined, path: revokePath('missing') },
      { method: 'DELETE', body: undefined, path: keyPath('missing') },
    ] as const;

    for (const attempt of attempts) {
      const response = await call(app, attempt.path, {
        method: attempt.method,
        ...(attempt.body === undefined ? {} : { body: attempt.body }),
        cookie,
      });
      expect(response.status, attempt.method).toBe(404);
      expect((await errorOf(response)).kind).toBe('not_found');
    }
  });

  it('is behind the session guard, so one key cannot manage another', async () => {
    const response = await call(app, KEYS_PATH);
    expect(response.status).toBe(401);
  });
});

describe('the /v1 guard', () => {
  it('refuses a request with no key', async () => {
    const response = await call(app, '/v1/chat/completions', { method: 'POST', body: {} });

    expect(response.status).toBe(401);
    expect((await v1ErrorOf(response)).kind).toBe('authentication');
  });

  it('refuses a header that is not a bearer token', async () => {
    const response = await call(app, '/v1/chat/completions', {
      method: 'POST',
      body: {},
      authorization: 'Basic abc123',
    });
    expect(response.status).toBe(401);
  });

  it('refuses a secret that was never issued', async () => {
    expect((await present(app, 'rk-not-a-real-key')).status).toBe(401);
  });

  it('admits a live key through to the data plane', async () => {
    const { secret } = await mintKey(app, cookie, { name: 'laptop' });

    // A live key clears the guard and reaches the route, which rejects the empty
    // body. The point is that the status is the route's and not a credential
    // refusal — the guard would have answered 401 first.
    const admitted = await present(app, secret);
    expect(admitted.status).toBe(400);
    expect((await v1ErrorOf(admitted)).kind).toBe('invalid_request');
  });

  it('refuses a revoked key', async () => {
    const { apiKey, secret } = await mintKey(app, cookie, { name: 'laptop' });
    await call(app, revokePath(apiKey.id), { method: 'POST', cookie });

    const refused = await present(app, secret);
    expect(refused.status).toBe(401);
    expect((await v1ErrorOf(refused)).message).toContain('revoked');
  });

  it('refuses an expired key', async () => {
    const { secret } = await mintKey(app, cookie, {
      name: 'laptop',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });

    const refused = await present(app, secret);
    expect(refused.status).toBe(401);
    expect((await v1ErrorOf(refused)).message).toContain('expired');
  });

  it('refuses an exhausted key with quota_exhausted', async () => {
    const { apiKey, secret } = await mintKey(app, cookie, {
      name: 'laptop',
      budgetRequests: 2,
    });
    server.apiKeys.recordUsage(apiKey.id, { requests: 2, inputTokens: 0, outputTokens: 0 });

    const refused = await present(app, secret);
    expect(refused.status).toBe(429);
    expect((await v1ErrorOf(refused)).kind).toBe('quota_exhausted');
  });

  it('enforces the per-minute ceiling with a retry-after', async () => {
    const { secret } = await mintKey(app, cookie, { name: 'laptop', rateLimitPerMinute: 1 });

    expect((await present(app, secret)).status).toBe(400);

    const refused = await present(app, secret);
    expect(refused.status).toBe(429);
    expect((await v1ErrorOf(refused)).kind).toBe('rate_limit');

    // The OpenAI envelope has no room for a retry hint, so the wait travels on the
    // header a client already reads for one — the same instruction, told once.
    const retryAfter = Number(refused.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  it('enforces the tokens-per-second ceiling', async () => {
    const { secret } = await mintKey(app, cookie, { name: 'laptop', tpsLimit: 1 });

    expect((await present(app, secret)).status).toBe(400);
    expect((await present(app, secret)).status).toBe(429);
  });

  it('does not let one key spend another key’s budget', async () => {
    const first = await mintKey(app, cookie, { name: 'first', rateLimitPerMinute: 1 });
    const second = await mintKey(app, cookie, { name: 'second', rateLimitPerMinute: 1 });

    // Spend the first key's whole allowance.
    expect((await present(app, first.secret)).status).toBe(400);
    expect((await present(app, first.secret)).status).toBe(429);

    // The second key is untouched by it.
    expect((await present(app, second.secret)).status).toBe(400);
  });
});
