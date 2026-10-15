import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_API_PREFIX,
  bulkResultSchema,
  consoleErrorSchema,
  consolePaths,
  okSchema,
  proxyCheckResultSchema,
  proxiesResponseSchema,
  proxiesSummarySchema,
  smsProviderCheckResultSchema,
  smsProvidersResponseSchema,
  smsProvidersSummarySchema,
} from '@contracts';
import type { Proxy, SmsProvider } from '@contracts';

import { createProxyProbe, type ProxyProbe } from '@server/automation/proxy-probe.ts';
import { createSmsChecker, type SmsChecker } from '@server/automation/sms-check.ts';
import { buildApp } from '@server/app.ts';
import { EgressPolicy } from '@server/security/egress.ts';
import { SecretBox } from '@server/security/secret-box.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The automation's two credential pools (C7a, FR-5.x).
 *
 * Route-level over the real composition. Both pools have the same shape — masked
 * read model, encrypted secret, health a check refreshes — so the assertions run
 * the same way for each, and what differs is only what a check means: a proxy
 * check is a real request through the proxy, and a balance check is a real call
 * to the activation service. Both are injected here, because neither is a thing a
 * test box can do.
 *
 * The assertion worth naming is the credential one. Both read models promise the
 * secret is write-only, and a route test is where "the read model never returns
 * it" is worth pinning — the same rule the account and API-key suites pin.
 */

const PASSWORD = 'correct-horse-battery';
const KEY_HEX = 'ab'.repeat(32);

type App = ReturnType<typeof buildApp>;

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

function pathOf(template: string, id: string): string {
  return `${CONSOLE_API_PREFIX}${template.replace(':id', id)}`;
}

const PROXIES_PATH = `${CONSOLE_API_PREFIX}${consolePaths.proxies}`;
const PROXIES_SUMMARY_PATH = `${CONSOLE_API_PREFIX}${consolePaths.proxiesSummary}`;
const PROXIES_IMPORT_PATH = `${CONSOLE_API_PREFIX}${consolePaths.proxiesImport}`;
const PROXIES_CHECK_PATH = `${CONSOLE_API_PREFIX}${consolePaths.proxiesCheck}`;
const SMS_PATH = `${CONSOLE_API_PREFIX}${consolePaths.smsProviders}`;
const SMS_SUMMARY_PATH = `${CONSOLE_API_PREFIX}${consolePaths.smsProvidersSummary}`;
const SMS_CHECK_PATH = `${CONSOLE_API_PREFIX}${consolePaths.smsProvidersCheck}`;

/** A probe that answers whatever the test says, and records what it was asked. */
function fakeProbe(
  answer: (host: string) => { health: 'healthy' | 'slow' | 'dead'; latencyMs: number | null },
): { probe: ProxyProbe; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    probe: {
      probe: (proxy) => {
        seen.push(`${proxy.protocol}://${proxy.host}:${String(proxy.port)}`);
        return Promise.resolve(answer(proxy.host));
      },
    },
  };
}

/** A checker that answers whatever the test says, keyed on the key it was given. */
function fakeChecker(
  answer: (apiKey: string) => {
    status: 'active' | 'error';
    balance: number | null;
    currency: string | null;
  },
): { checker: SmsChecker; seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    checker: {
      check: (_kind, apiKey) => {
        seen.push(apiKey);
        return Promise.resolve(answer(apiKey));
      },
    },
  };
}

const PROXY_INPUT = {
  protocol: 'http',
  host: '203.0.113.10',
  port: 8080,
  username: null,
  password: null,
  note: null,
};

const SMS_INPUT = {
  kind: '5sim',
  label: '5sim — main',
  apiKey: 'abcdefghijklmnopqrstuvwxyz',
  country: null,
  operator: null,
  product: null,
  note: null,
};

let server: TestServer;
let app: App;
let cookie: string;
let probeSeen: string[];

beforeEach(async () => {
  const probe = fakeProbe(() => ({ health: 'healthy', latencyMs: 120 }));
  probeSeen = probe.seen;
  server = makeServer({
    secrets: new SecretBox(KEY_HEX),
    proxyProbe: probe.probe,
    smsChecker: fakeChecker(() => ({ status: 'active', balance: 42.5, currency: 'RUB' })).checker,
  });
  server.lifecycle.markReady();
  app = buildApp(server);
  cookie = await signIn(app);
});

afterEach(() => {
  server.close();
});

async function createProxy(app: App, cookie: string, body: unknown = PROXY_INPUT): Promise<Proxy> {
  const response = await call(app, PROXIES_PATH, { method: 'POST', body, cookie });
  expect(response.status).toBe(201);
  return (await response.json()) as Proxy;
}

async function createSms(app: App, cookie: string, body: unknown = SMS_INPUT): Promise<SmsProvider> {
  const response = await call(app, SMS_PATH, { method: 'POST', body, cookie });
  expect(response.status).toBe(201);
  return (await response.json()) as SmsProvider;
}

describe('the session guard', () => {
  it('refuses the proxy pool without a session', async () => {
    const response = await call(app, PROXIES_PATH);
    expect(response.status).toBe(401);
    expect((await errorOf(response)).kind).toBe('authentication');
  });

  it('refuses the SMS pool without a session', async () => {
    const response = await call(app, SMS_PATH);
    expect(response.status).toBe(401);
  });
});

describe('the proxy pool', () => {
  it('creates a proxy that has never been checked', async () => {
    const proxy = await createProxy(app, cookie);

    expect(proxy.host).toBe('203.0.113.10');
    expect(proxy.port).toBe(8080);
    expect(proxy.hasAuth).toBe(false);
    // Never checked and checked-and-failed are different facts, and the page
    // shows them differently — so a fresh entry is `untested`, not `dead`.
    expect(proxy.health).toBe('untested');
    expect(proxy.lastCheckedAt).toBeNull();
    expect(proxy.dispatchCount).toBe(0);
  });

  it('reports hasAuth without ever returning the credential', async () => {
    const proxy = await createProxy(app, cookie, {
      ...PROXY_INPUT,
      username: 'alice',
      password: 'hunter2',
    });

    expect(proxy.hasAuth).toBe(true);
    // The read model carries a boolean and nothing else: a page that echoed the
    // row would print a paid residential password on screen.
    expect(JSON.stringify(proxy)).not.toContain('hunter2');
    expect(JSON.stringify(proxy)).not.toContain('alice');
  });

  it('stores the credential encrypted, so a database read does not yield it', async () => {
    const proxy = await createProxy(app, cookie, {
      ...PROXY_INPUT,
      username: 'alice',
      password: 'hunter2',
    });

    const stored = server.persistence.sqlite
      .query<{ credential_envelope: string | null }, [string]>(
        'select credential_envelope from proxies where id = ?',
      )
      .get(proxy.id);

    expect(stored?.credential_envelope).not.toBeNull();
    expect(stored?.credential_envelope ?? '').not.toContain('hunter2');
    // It round-trips through the box, which is what makes it usable by a probe.
    expect(server.secrets?.decrypt(stored?.credential_envelope ?? '')).toContain('hunter2');
  });

  it('lists and filters', async () => {
    await createProxy(app, cookie, { ...PROXY_INPUT, host: 'a.example', protocol: 'http' });
    await createProxy(app, cookie, { ...PROXY_INPUT, host: 'b.example', protocol: 'socks5' });

    const all = proxiesResponseSchema.parse(
      await (await call(app, PROXIES_PATH, { cookie })).json(),
    );
    expect(all.total).toBe(2);

    const socks = proxiesResponseSchema.parse(
      await (await call(app, `${PROXIES_PATH}?protocol=socks5`, { cookie })).json(),
    );
    expect(socks.items.map((row) => row.host)).toEqual(['b.example']);

    const search = proxiesResponseSchema.parse(
      await (await call(app, `${PROXIES_PATH}?q=a.example`, { cookie })).json(),
    );
    expect(search.items.map((row) => row.host)).toEqual(['a.example']);
  });

  it('refuses an unknown protocol rather than answering everything', async () => {
    const response = await call(app, `${PROXIES_PATH}?protocol=gopher`, { cookie });
    expect(response.status).toBe(400);
  });

  it('pages', async () => {
    for (let index = 0; index < 3; index += 1) {
      await createProxy(app, cookie, { ...PROXY_INPUT, host: `h${String(index)}.example` });
    }

    const first = proxiesResponseSchema.parse(
      await (await call(app, `${PROXIES_PATH}?limit=2`, { cookie })).json(),
    );
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(3);
    expect(first.nextCursor).toBe('2');

    const second = proxiesResponseSchema.parse(
      await (await call(app, `${PROXIES_PATH}?limit=2&cursor=2`, { cookie })).json(),
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it('edits where a proxy points, and forgets what was known about the old address', async () => {
    const proxy = await createProxy(app, cookie);
    await call(app, PROXIES_CHECK_PATH, { method: 'POST', body: { ids: [proxy.id] }, cookie });

    const moved = await call(app, pathOf(consolePaths.proxy, proxy.id), {
      method: 'PATCH',
      body: { host: '198.51.100.7' },
      cookie,
    });

    const updated = (await moved.json()) as Proxy;
    expect(updated.host).toBe('198.51.100.7');
    // The old verdict was about a different address. Carrying it over would report
    // a health nobody measured.
    expect(updated.health).toBe('untested');
    expect(updated.lastCheckedAt).toBeNull();
  });

  it('deletes', async () => {
    const proxy = await createProxy(app, cookie);

    const response = await call(app, pathOf(consolePaths.proxy, proxy.id), {
      method: 'DELETE',
      cookie,
    });

    expect(okSchema.parse(await response.json()).ok).toBe(true);
    expect(server.proxies.findById(proxy.id)).toBeNull();
  });

  it('answers not_found for an id that does not exist', async () => {
    const response = await call(app, pathOf(consolePaths.proxy, 'nope'), { cookie });
    expect(response.status).toBe(404);
  });
});

describe('importing a paste', () => {
  it('adds every readable line and reports the rest against their line numbers', async () => {
    const response = await call(app, PROXIES_IMPORT_PATH, {
      method: 'POST',
      body: {
        payload: [
          '203.0.113.10:8080',
          'socks5://alice:pw@203.0.113.11:1080',
          '',
          'this line is not a proxy',
          'http://203.0.113.12:3128',
        ].join('\n'),
      },
      cookie,
    });

    const result = bulkResultSchema.parse(await response.json());
    // Blank lines are skipped, so the count is over the four that carried content.
    expect(result.requested).toBe(4);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(1);
    // Named by line number in the operator's own paste, which is what they can find.
    expect(result.errors[0]?.id).toBe('line 4');
  });

  it('stores the credentials a pasted line carried', async () => {
    await call(app, PROXIES_IMPORT_PATH, {
      method: 'POST',
      body: { payload: 'http://alice:hunter2@203.0.113.10:8080' },
      cookie,
    });

    const page = proxiesResponseSchema.parse(
      await (await call(app, PROXIES_PATH, { cookie })).json(),
    );
    expect(page.items[0]?.hasAuth).toBe(true);
  });

  it('refuses an empty paste', async () => {
    const response = await call(app, PROXIES_IMPORT_PATH, {
      method: 'POST',
      body: { payload: '' },
      cookie,
    });
    expect(response.status).toBe(400);
  });
});

describe('checking the pool', () => {
  it('probes the named proxies and records the verdict', async () => {
    const proxy = await createProxy(app, cookie);

    const response = await call(app, PROXIES_CHECK_PATH, {
      method: 'POST',
      body: { ids: [proxy.id] },
      cookie,
    });

    const result = proxyCheckResultSchema.parse(await response.json());
    expect(result.results).toEqual([{ id: proxy.id, health: 'healthy', latencyMs: 120 }]);
    // The probe was handed the proxy's own address, scheme included — which is
    // what Bun's fetch needs to route through it.
    expect(probeSeen).toEqual(['http://203.0.113.10:8080']);

    const stored = server.proxies.findById(proxy.id);
    expect(stored?.health).toBe('healthy');
    expect(stored?.lastCheckedAt).not.toBeNull();
  });

  it('checks the whole pool when the list is empty', async () => {
    await createProxy(app, cookie, { ...PROXY_INPUT, host: 'a.example' });
    await createProxy(app, cookie, { ...PROXY_INPUT, host: 'b.example' });

    const response = await call(app, PROXIES_CHECK_PATH, {
      method: 'POST',
      body: { ids: [] },
      cookie,
    });

    const result = proxyCheckResultSchema.parse(await response.json());
    expect(result.results).toHaveLength(2);
    expect(probeSeen).toHaveLength(2);
  });

  it('marks a proxy dead when the probe cannot reach it', async () => {
    const failing = makeServer({
      secrets: new SecretBox(KEY_HEX),
      proxyProbe: fakeProbe(() => ({ health: 'dead', latencyMs: null })).probe,
    });
    failing.lifecycle.markReady();
    const failingApp = buildApp(failing);
    const failingCookie = await signIn(failingApp);

    const proxy = await createProxy(failingApp, failingCookie);
    const response = await call(failingApp, PROXIES_CHECK_PATH, {
      method: 'POST',
      body: { ids: [proxy.id] },
      cookie: failingCookie,
    });

    const result = proxyCheckResultSchema.parse(await response.json());
    expect(result.results[0]?.health).toBe('dead');
    expect(result.results[0]?.latencyMs).toBeNull();
    failing.close();
  });

  it('tallies the pool for the summary tiles', async () => {
    const one = await createProxy(app, cookie, { ...PROXY_INPUT, host: 'a.example' });
    await createProxy(app, cookie, { ...PROXY_INPUT, host: 'b.example' });
    await call(app, PROXIES_CHECK_PATH, { method: 'POST', body: { ids: [one.id] }, cookie });

    const summary = proxiesSummarySchema.parse(
      await (await call(app, PROXIES_SUMMARY_PATH, { cookie })).json(),
    );

    expect(summary.total).toBe(2);
    expect(summary.healthy).toBe(1);
    // The other one has never been checked, which is not the same as dead.
    expect(summary.untested).toBe(1);
  });
});

describe('the SMS pool', () => {
  it('creates a key that has never been checked, with a masked hint', async () => {
    const provider = await createSms(app, cookie);

    expect(provider.label).toBe('5sim — main');
    expect(provider.status).toBe('untested');
    expect(provider.balance).toBeNull();
    // `first4••••last4`: enough to tell two keys apart, not enough to use.
    expect(provider.keyHint).toBe('abcd••••wxyz');
    expect(JSON.stringify(provider)).not.toContain(SMS_INPUT.apiKey);
  });

  it('stores the key encrypted', async () => {
    const provider = await createSms(app, cookie);

    const stored = server.persistence.sqlite
      .query<{ credential_envelope: string | null }, [string]>(
        'select credential_envelope from sms_providers where id = ?',
      )
      .get(provider.id);

    expect(stored?.credential_envelope ?? '').not.toContain(SMS_INPUT.apiKey);
    expect(server.secrets?.decrypt(stored?.credential_envelope ?? '')).toBe(SMS_INPUT.apiKey);
  });

  it('checks a balance and records it', async () => {
    const provider = await createSms(app, cookie);

    const response = await call(app, SMS_CHECK_PATH, {
      method: 'POST',
      body: { ids: [provider.id] },
      cookie,
    });

    const result = smsProviderCheckResultSchema.parse(await response.json());
    expect(result.results[0]?.status).toBe('active');
    expect(result.results[0]?.balance).toBe(42.5);
    expect(result.results[0]?.currency).toBe('RUB');
  });

  it('leaves a disabled key alone through a check', async () => {
    const provider = await createSms(app, cookie);
    server.smsProviders.update(provider.id, {}, new Date().toISOString());
    server.smsProviders.recordCheck(
      provider.id,
      { status: 'disabled', balance: 10, currency: 'RUB' },
      new Date().toISOString(),
    );

    const response = await call(app, SMS_CHECK_PATH, {
      method: 'POST',
      body: { ids: [provider.id] },
      cookie,
    });

    const result = smsProviderCheckResultSchema.parse(await response.json());
    // A check reads the balance; it does not overrule the person who switched the
    // key off — the same rule the account pool follows.
    expect(result.results[0]?.status).toBe('disabled');
  });

  it('rotates the key and its hint together', async () => {
    const provider = await createSms(app, cookie);

    const response = await call(app, pathOf(consolePaths.smsProvider, provider.id), {
      method: 'PATCH',
      body: { apiKey: 'zzzzzzzzzzzzzzzzzzzzzzzzzz' },
      cookie,
    });

    const updated = (await response.json()) as SmsProvider;
    expect(updated.keyHint).toBe('zzzz••••zzzz');
    // The old verdict was about a different key, so it is cleared rather than
    // carried over.
    expect(updated.status).toBe('untested');
  });

  it('edits the last-used triple without touching the key', async () => {
    const provider = await createSms(app, cookie);

    const response = await call(app, pathOf(consolePaths.smsProvider, provider.id), {
      method: 'PATCH',
      body: { country: 'russia', operator: 'any', product: 'codebuddy' },
      cookie,
    });

    const updated = (await response.json()) as SmsProvider;
    expect(updated.country).toBe('russia');
    expect(updated.keyHint).toBe(provider.keyHint);
  });

  it('lists, filters and tallies', async () => {
    await createSms(app, cookie, { ...SMS_INPUT, label: 'one' });
    const two = await createSms(app, cookie, { ...SMS_INPUT, label: 'two' });
    await call(app, SMS_CHECK_PATH, { method: 'POST', body: { ids: [two.id] }, cookie });

    const listed = smsProvidersResponseSchema.parse(
      await (await call(app, SMS_PATH, { cookie })).json(),
    );
    expect(listed.total).toBe(2);

    const active = smsProvidersResponseSchema.parse(
      await (await call(app, `${SMS_PATH}?status=active`, { cookie })).json(),
    );
    expect(active.items.map((row) => row.label)).toEqual(['two']);

    const summary = smsProvidersSummarySchema.parse(
      await (await call(app, SMS_SUMMARY_PATH, { cookie })).json(),
    );
    expect(summary.total).toBe(2);
    expect(summary.active).toBe(1);
    expect(summary.untested).toBe(1);
  });

  it('deletes', async () => {
    const provider = await createSms(app, cookie);

    const response = await call(app, pathOf(consolePaths.smsProvider, provider.id), {
      method: 'DELETE',
      cookie,
    });

    expect(okSchema.parse(await response.json()).ok).toBe(true);
    expect(server.smsProviders.findById(provider.id)).toBeNull();
  });

  it('refuses an empty key', async () => {
    const response = await call(app, SMS_PATH, {
      method: 'POST',
      body: { ...SMS_INPUT, apiKey: '' },
      cookie,
    });
    expect(response.status).toBe(400);
  });
});

describe('the real probe and checker', () => {
  it('refuses a proxy pointing at a private address rather than probing it', async () => {
    // The proxy list is operator-supplied input like any other, and it is the one
    // piece of it that names a host rutekit will connect to — so it gets the same
    // egress guard a provider URL does.
    const egress = new EgressPolicy();
    const probe = createProxyProbe({
      egress,
      probeUrl: 'https://example.com/generate_204',
      timeoutMs: 100,
      fetch: () => {
        throw new Error('the probe must not have been called');
      },
    });

    const result = await probe.probe({
      protocol: 'http',
      host: '127.0.0.1',
      port: 8080,
      username: null,
      password: null,
    });

    expect(result.health).toBe('dead');
    expect(result.latencyMs).toBeNull();
    expect(result.error).toContain('not permitted');
  });

  it('grades a slow proxy as slow rather than dead', async () => {
    // Three values, not two: a proxy that answers in three seconds is not dead and
    // is not healthy either, and collapsing that would lose the one distinction an
    // operator acts on when picking an egress.
    let clock = 0;
    const probe = createProxyProbe({
      egress: new EgressPolicy(),
      probeUrl: 'https://example.com/generate_204',
      timeoutMs: 100,
      now: () => {
        clock += 3_000;
        return clock;
      },
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    });

    // A public address, not a documentation one: the egress guard refuses
    // TEST-NET ranges, so a `203.0.113.x` fixture would be marked dead for a
    // reason that has nothing to do with the timing under test.
    const result = await probe.probe({
      protocol: 'http',
      host: '1.2.3.4',
      port: 8080,
      username: null,
      password: null,
    });

    expect(result.health).toBe('slow');
    expect(result.latencyMs).toBe(3_000);
  });

  it('treats any answer as a working egress, not just a 200', async () => {
    // A 403 from the target is the proxy working and the endpoint refusing; the
    // probe is asking whether the egress carries a request, not whether the
    // target likes it.
    const probe = createProxyProbe({
      egress: new EgressPolicy(),
      probeUrl: 'https://example.com/generate_204',
      timeoutMs: 100,
      fetch: () => Promise.resolve(new Response(null, { status: 403 })),
    });

    const result = await probe.probe({
      protocol: 'http',
      host: '1.2.3.4',
      port: 8080,
      username: null,
      password: null,
    });

    expect(result.health).toBe('healthy');
  });

  it('reads a balance out of the activation service', async () => {
    const checker = createSmsChecker({
      fetch: () =>
        Promise.resolve(
          Response.json({ id: 1, email: 'a@b.c', balance: 123.45, frozen_balance: 0 }),
        ),
      timeoutMs: 100,
    });

    expect(await checker.check('5sim', 'key')).toEqual({
      status: 'active',
      balance: 123.45,
      currency: 'RUB',
    });
  });

  it('reads a refusal as an error status rather than throwing', async () => {
    // A key that 401s and a service that never answers mean the same thing to the
    // operator: this key will not rent a number. Throwing would fail the whole
    // pool's check for one bad key, which is the case the pool exists to survive.
    const checker = createSmsChecker({
      fetch: () => Promise.resolve(new Response('nope', { status: 401 })),
      timeoutMs: 100,
    });

    const result = await checker.check('5sim', 'bad');
    expect(result.status).toBe('error');
    expect(result.balance).toBeNull();
    expect(result.error).toContain('401');
  });

  it('clamps a negative balance, which is how the service reports a debt', async () => {
    const checker = createSmsChecker({
      fetch: () => Promise.resolve(Response.json({ balance: -5 })),
      timeoutMs: 100,
    });

    const result = await checker.check('5sim', 'key');
    // `nonnegative` in the contract is the honest reading of "nothing left".
    expect(result.balance).toBe(0);
  });

  it('reads an unrecognised body as an error rather than as a working key', async () => {
    const checker = createSmsChecker({
      fetch: () => Promise.resolve(Response.json({ ok: true })),
      timeoutMs: 100,
    });

    const result = await checker.check('5sim', 'key');
    expect(result.status).toBe('error');
  });

  it('answers a failed check for an unsupported service', async () => {
    const checker = createSmsChecker({
      fetch: () => Promise.resolve(Response.json({ balance: 1 })),
      timeoutMs: 100,
    });

    const result = await checker.check('sms-activate', 'key');
    expect(result.status).toBe('error');
    expect(result.error).toContain('unsupported');
  });
});
