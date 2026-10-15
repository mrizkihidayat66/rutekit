import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONSOLE_API_PREFIX, consoleErrorSchema, consolePath, consolePaths } from '@contracts';
import { createProviderRegistry, type Fetcher, type HttpRequest } from '@registry';
import { providerManifests } from '@registry/providers/index.ts';

import { buildApp } from '@server/app.ts';
import { AppError } from '@server/errors.ts';
import { silentLogger } from '@server/observability/logger.ts';
import { openPersistence, type Persistence } from '@server/persistence/client.ts';
import { runMigrations } from '@server/persistence/migrate.ts';
import {
  createProviderAccountsRepository,
  type ProviderAccountsRepository,
} from '@server/persistence/provider-accounts.ts';
import { createBrowserFlow, type BrowserFlowDeps } from '@server/providers/oauth/browser.ts';
import { createDeviceSessions, type Scheduler } from '@server/providers/oauth/device-session.ts';
import { pollDeviceToken, startDeviceFlow } from '@server/providers/oauth/device.ts';
import { buildAuthorizeUrl, exchangeCode, refreshToken } from '@server/providers/oauth/flow.ts';
import { emailFromIdToken, maskEmail } from '@server/providers/oauth/identity.ts';
import { createPendingFlows } from '@server/providers/oauth/pending.ts';
import { codeChallengeS256, createCodeVerifier, createState } from '@server/providers/oauth/pkce.ts';
import {
  clientFor,
  NO_KEY_MESSAGE,
  oauthAuth,
  redirectPath,
  redirectUri,
  requireSecrets,
} from '@server/providers/oauth/resolve.ts';
import { createProviderOauthService } from '@server/providers/oauth/service.ts';
import { createCredentialStore } from '@server/providers/oauth/store.ts';
import {
  asNumber,
  asString,
  failed,
  parseToken,
  postForm,
  postToken,
  type OauthToken,
} from '@server/providers/oauth/wire.ts';
import { SecretBox } from '@server/security/secret-box.ts';

import { makeServer, type TestServer } from './helpers.ts';

/**
 * The OAuth module (C3b2), from the random bytes up to the service the route calls.
 *
 * Everything here is driven through an injected `Fetcher` and an injected clock,
 * because the module was written to be exercisable that way: `pkce.ts` is random
 * bytes, `wire.ts` is one form POST read into one shape, `flow.ts` and `device.ts`
 * are the two dialects of that call, and `pending.ts` and `device-session.ts` are
 * the only two things that carry state between requests. Nothing reaches a socket
 * and nothing waits on a real timer, so a failure names the step that broke rather
 * than a timeout.
 *
 * The store runs against a real in-memory database, for the reason
 * `provider-accounts.test.ts` does: the claims worth checking are that a token
 * arrives encrypted and that a re-sign-in replaces a row instead of adding one,
 * and both of those are the driver's behaviour, not a mock's. Those few tests are
 * the only ones that open a database.
 */

const ORIGIN = 'http://localhost:8787';
const registry = createProviderRegistry(providerManifests);

/** One provider, or a loud failure naming the one that is missing. */
function manifest(id: string) {
  const found = registry.get(id);
  if (found === undefined) throw new Error(`the catalogue has no provider '${id}'`);
  return found;
}

interface Call {
  readonly url: string;
  readonly init: HttpRequest;
}

interface Reply {
  readonly status: number;
  readonly body: string;
}

/** One canned answer, so a test reads as "the endpoint said this". */
function reply(body: string, status = 200): Reply {
  return { status, body };
}

/**
 * A `Fetcher` that records what it was asked and answers from the handler.
 *
 * Not `async`: `require-await` is on, and a fake with nothing to await should not
 * pretend otherwise. A handler that throws is turned into a rejected promise, so
 * the network-failure path is driven the same way the real transport drives it.
 */
function fakeFetch(handler: (call: Call) => Reply): { fetch: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: Fetcher = (url, init) => {
    const call = { url, init };
    calls.push(call);
    try {
      const answer = handler(call);
      return Promise.resolve({
        status: answer.status,
        text: () => Promise.resolve(answer.body),
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return { fetch, calls };
}

function token(overrides: Partial<OauthToken> = {}): OauthToken {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    tokenType: 'Bearer',
    scope: 'openid',
    expiresAt: '2026-10-13T01:00:00.000Z',
    idToken: null,
    ...overrides,
  };
}

/** A signed-looking JWT whose middle segment is the payload a test wants read. */
function idToken(payload: Record<string, unknown>): string {
  const segment = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${segment({ alg: 'none' })}.${segment(payload)}.signature`;
}

/** Let every already-resolved microtask run, so a scheduled poll can finish. */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

describe('pkce', () => {
  it('mints 43 base64url characters for the verifier and the state', () => {
    expect(createCodeVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createState()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats itself', () => {
    expect(createCodeVerifier()).not.toBe(createCodeVerifier());
    expect(createState()).not.toBe(createState());
  });

  it('hashes the verifier to the RFC 7636 S256 challenge', () => {
    // The RFC's own worked example — the only way to prove S256 rather than
    // "some 43-character string".
    expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('does not send the verifier as its own challenge', () => {
    const verifier = createCodeVerifier();
    expect(codeChallengeS256(verifier)).not.toBe(verifier);
  });
});

describe('wire', () => {
  it('posts a form body with the form headers', async () => {
    const { fetch, calls } = fakeFetch(() => reply('{"ok":true}'));

    const result = await postForm(
      'https://p.test/token',
      new URLSearchParams({ a: '1', b: '2' }),
      fetch,
    );

    expect(result).toEqual({ ok: true, payload: { ok: true } });
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0]?.init.body).toBe('a=1&b=2');
  });

  it('reads an RFC 6749 refusal into a sentence and keeps the code', async () => {
    const { fetch } = fakeFetch(() =>
      reply('{"error":"invalid_grant","error_description":"code expired"}', 400),
    );

    const result = await postForm('https://p.test/token', new URLSearchParams(), fetch);

    expect(result).toEqual({
      ok: false,
      message: 'The endpoint refused the request (invalid_grant: code expired).',
      errorCode: 'invalid_grant',
    });
  });

  it('reports a bare 4xx without inventing a reason', async () => {
    const { fetch } = fakeFetch(() => reply('', 400));

    const result = await postForm('https://p.test/token', new URLSearchParams(), fetch);

    expect(result).toEqual({
      ok: false,
      message: 'The endpoint answered HTTP 400.',
      errorCode: null,
    });
  });

  it('turns an unreachable host into a message, not a throw', async () => {
    const { fetch } = fakeFetch(() => {
      throw new Error('ECONNREFUSED');
    });

    const result = await postForm('https://p.test/token', new URLSearchParams(), fetch);

    expect(result).toEqual({
      ok: false,
      message: 'Could not reach the endpoint: ECONNREFUSED',
      errorCode: null,
    });
  });

  it('refuses a 200 whose body is not an object', async () => {
    const { fetch } = fakeFetch(() => reply('not json'));

    const result = await postForm('https://p.test/token', new URLSearchParams(), fetch);

    expect(result).toEqual({
      ok: false,
      message: 'The endpoint answered, but its response could not be read.',
      errorCode: null,
    });
  });

  it('reads a token and turns expires_in into an absolute instant', () => {
    const parsed = parseToken(
      { access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', expires_in: 3600 },
      () => 0,
    );

    expect(parsed).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      tokenType: 'Bearer',
      scope: null,
      expiresAt: '1970-01-01T01:00:00.000Z',
      idToken: null,
    });
  });

  it('accepts a numeric string for expires_in and leaves a missing one null', () => {
    expect(parseToken({ access_token: 'at', expires_in: '1800' }, () => 0)?.expiresAt).toBe(
      '1970-01-01T00:30:00.000Z',
    );
    expect(parseToken({ access_token: 'at' }, () => 0)?.expiresAt).toBeNull();
  });

  it('needs an access_token and nothing else', () => {
    expect(parseToken({}, () => 0)).toBeNull();
    expect(parseToken({ access_token: '' }, () => 0)).toBeNull();
    expect(parseToken({ access_token: 'at' }, () => 0)?.accessToken).toBe('at');
  });

  it('fails a token call whose body carried no token', async () => {
    const { fetch } = fakeFetch(() => reply('{"scope":"openid"}'));

    const result = await postToken('https://p.test/token', new URLSearchParams(), fetch, () => 0);

    expect(result).toEqual({
      ok: false,
      message: 'The token endpoint answered, but its response carried no token.',
    });
  });

  it('coerces only what it can name', () => {
    expect(asString('x')).toBe('x');
    expect(asString('')).toBeNull();
    expect(asString(7)).toBeNull();
    expect(asNumber(7)).toBe(7);
    expect(asNumber('7')).toBe(7);
    expect(asNumber('seven')).toBeNull();
    expect(asNumber(undefined)).toBeNull();
  });

  it('builds the failure arm the same way everywhere', () => {
    expect(failed('nope')).toEqual({ ok: false, message: 'nope' });
  });
});

describe('the authorize URL', () => {
  const base = {
    authorizeUrl: 'https://p.test/authorize',
    clientId: 'client-1',
    redirectUri: 'https://rutekit.test/callback',
    scopes: ['openid', 'email'],
    state: 'state-1',
    codeChallenge: 'challenge-1',
    extraParams: {},
  };

  it('carries the code flow, the scope and the PKCE challenge', () => {
    const url = new URL(buildAuthorizeUrl(base));

    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe('https://rutekit.test/callback');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('scope')).toBe('openid email');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('omits the scope and the challenge when there are none', () => {
    const url = new URL(buildAuthorizeUrl({ ...base, scopes: [], codeChallenge: null }));

    expect(url.searchParams.has('scope')).toBe(false);
    expect(url.searchParams.has('code_challenge')).toBe(false);
    expect(url.searchParams.has('code_challenge_method')).toBe(false);
  });

  it('lets the manifest have the last word on its own URL', () => {
    const url = new URL(
      buildAuthorizeUrl({
        ...base,
        authorizeUrl: 'https://p.test/authorize?tenant=t1',
        extraParams: { client_id: 'override', prompt: 'consent' },
      }),
    );

    expect(url.searchParams.get('tenant')).toBe('t1');
    expect(url.searchParams.get('client_id')).toBe('override');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });
});

describe('the exchange and the renewal', () => {
  it('sends the code, the redirect and the verifier', async () => {
    const { fetch, calls } = fakeFetch(() => reply('{"access_token":"at"}'));

    const result = await exchangeCode({
      tokenUrl: 'https://p.test/token',
      clientId: 'client-1',
      clientSecret: 'secret-1',
      code: 'code-1',
      codeVerifier: 'verifier-1',
      redirectUri: 'https://rutekit.test/callback',
      fetch,
      now: () => 0,
    });

    const body = new URLSearchParams(calls[0]?.init.body ?? '');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-1');
    expect(body.get('client_id')).toBe('client-1');
    expect(body.get('client_secret')).toBe('secret-1');
    expect(body.get('code_verifier')).toBe('verifier-1');
    expect(body.get('redirect_uri')).toBe('https://rutekit.test/callback');
    expect(result.ok).toBe(true);
  });

  it('leaves the verifier and the secret out when there are none', async () => {
    const { fetch, calls } = fakeFetch(() => reply('{"access_token":"at"}'));

    await exchangeCode({
      tokenUrl: 'https://p.test/token',
      clientId: 'client-1',
      clientSecret: null,
      code: 'code-1',
      codeVerifier: null,
      redirectUri: 'https://rutekit.test/callback',
      fetch,
      now: () => 0,
    });

    const body = new URLSearchParams(calls[0]?.init.body ?? '');
    expect(body.has('code_verifier')).toBe(false);
    expect(body.has('client_secret')).toBe(false);
  });

  it('renews with the refresh token and no redirect', async () => {
    const { fetch, calls } = fakeFetch(() => reply('{"access_token":"at2"}'));

    const result = await refreshToken({
      tokenUrl: 'https://p.test/token',
      clientId: 'client-1',
      clientSecret: null,
      refreshToken: 'refresh-1',
      fetch,
      now: () => 0,
    });

    const body = new URLSearchParams(calls[0]?.init.body ?? '');
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
    expect(body.has('redirect_uri')).toBe(false);
    expect(result.ok).toBe(true);
  });
});

describe('the device flow', () => {
  const start = {
    deviceCodeUrl: 'https://p.test/device',
    clientId: 'client-1',
    scopes: ['openid'],
    now: () => 0,
  };

  it('prefers the complete verification URI and clamps the interval', async () => {
    const { fetch } = fakeFetch(() =>
      reply(
        JSON.stringify({
          device_code: 'dev-1',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://p.test/verify',
          verification_uri_complete: 'https://p.test/verify?code=ABCD-EFGH',
          interval: 0,
          expires_in: 900,
        }),
      ),
    );

    const result = await startDeviceFlow({ ...start, fetch });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verificationUri).toBe('https://p.test/verify?code=ABCD-EFGH');
    expect(result.value.userCode).toBe('ABCD-EFGH');
    // Never poll faster than once a second, whatever the provider states.
    expect(result.value.intervalSeconds).toBe(1);
    expect(result.value.expiresAtMs).toBe(900_000);
  });

  it('falls back through the two older URI names and the RFC defaults', async () => {
    const { fetch } = fakeFetch(() =>
      reply(
        JSON.stringify({
          device_code: 'dev-1',
          user_code: 'AB',
          verification_url: 'https://p.test/v',
        }),
      ),
    );

    const result = await startDeviceFlow({ ...start, fetch });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verificationUri).toBe('https://p.test/v');
    expect(result.value.intervalSeconds).toBe(5);
    expect(result.value.expiresAtMs).toBe(600_000);
  });

  it('fails a start that could not be read', async () => {
    const { fetch } = fakeFetch(() => reply(JSON.stringify({ device_code: 'dev-1' })));

    const result = await startDeviceFlow({ ...start, fetch });

    expect(result.ok).toBe(false);
  });

  it('tells "not yet" from "give up" by the error code', async () => {
    const poll = {
      tokenUrl: 'https://p.test/token',
      clientId: 'client-1',
      deviceCode: 'dev-1',
      now: () => 0,
    };
    const pending = fakeFetch(() => reply('{"error":"authorization_pending"}', 400));
    const slow = fakeFetch(() => reply('{"error":"slow_down"}', 400));
    const refused = fakeFetch(() => reply('{"error":"access_denied"}', 400));

    expect(await pollDeviceToken({ ...poll, fetch: pending.fetch })).toEqual({ status: 'pending' });
    expect(await pollDeviceToken({ ...poll, fetch: slow.fetch })).toEqual({ status: 'slow_down' });
    expect((await pollDeviceToken({ ...poll, fetch: refused.fetch })).status).toBe('failed');
  });

  it('answers with the token once it is approved', async () => {
    const { fetch } = fakeFetch(() => reply('{"access_token":"at"}'));

    const result = await pollDeviceToken({
      tokenUrl: 'https://p.test/token',
      clientId: 'client-1',
      deviceCode: 'dev-1',
      fetch,
      now: () => 0,
    });

    expect(result.status).toBe('token');
  });
});

describe('the flows in flight', () => {
  const flow = (createdAtMs: number) => ({
    providerId: 'qoder',
    codeVerifier: 'verifier-1',
    redirectUri: 'https://rutekit.test/callback',
    createdAtMs,
  });

  it('hands a state back once and never again', () => {
    const pending = createPendingFlows({ now: () => 0 });
    pending.put('state-1', flow(0));

    expect(pending.take('state-1', 0)?.providerId).toBe('qoder');
    expect(pending.take('state-1', 0)).toBeNull();
    expect(pending.size).toBe(0);
  });

  it('refuses a state past its TTL', () => {
    const pending = createPendingFlows({ ttlMs: 1000, now: () => 0 });
    pending.put('state-1', flow(0));

    expect(pending.take('state-1', 1001)).toBeNull();
  });

  it('sweeps on the way in, so the map cannot grow past the TTL', () => {
    let clock = 0;
    const pending = createPendingFlows({ ttlMs: 1000, now: () => clock });
    pending.put('old', flow(0));
    clock = 5000;
    pending.put('new', flow(5000));

    expect(pending.size).toBe(1);
    expect(pending.sweep(5000)).toBe(0);
    expect(pending.sweep(7000)).toBe(1);
  });
});

describe('reading the account out of the id token', () => {
  it('reads the one claim, and only when it looks like an address', () => {
    expect(emailFromIdToken(idToken({ email: 'alice@example.com' }))).toBe('alice@example.com');
    expect(emailFromIdToken(idToken({ email: 'not-an-address' }))).toBeNull();
    expect(emailFromIdToken(idToken({ email: 7 }))).toBeNull();
    expect(emailFromIdToken(idToken({}))).toBeNull();
  });

  it('gives up on anything that is not a three-segment JWT', () => {
    expect(emailFromIdToken(null)).toBeNull();
    expect(emailFromIdToken('a.b')).toBeNull();
    expect(emailFromIdToken('a.!!!notbase64!!!.c')).toBeNull();
  });

  it('keeps enough of the address to tell two accounts apart', () => {
    expect(maskEmail('alice@example.com')).toBe('a***e@example.com');
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
    expect(maskEmail('no-at-sign')).toBe('***');
    expect(maskEmail('a@')).toBe('***');
  });
});

describe('the parts a sign-in shares', () => {
  it('refuses to start without somewhere to store the credential', () => {
    expect(() => requireSecrets(null)).toThrow(NO_KEY_MESSAGE);
    expect(() => requireSecrets(null)).toThrow(AppError);
    const box = new SecretBox('ab'.repeat(32));
    expect(requireSecrets(box)).toBe(box);
  });

  it('finds the provider sign-in mode, or says there is none', () => {
    expect(oauthAuth(manifest('qoder'))?.mode).toBe('oauth-browser');
    expect(oauthAuth(manifest('kiro'))?.mode).toBe('oauth-device');
    expect(oauthAuth(manifest('groq'))).toBeNull();
  });

  it('lets the environment replace the shipped client', () => {
    expect(clientFor({}, 'codebuddy-intl', 'shipped', null)).toEqual({
      clientId: 'shipped',
      clientSecret: null,
    });
    expect(
      clientFor(
        {
          RUTEKIT_CODEBUDDY_INTL_OAUTH_CLIENT_ID: 'mine',
          RUTEKIT_CODEBUDDY_INTL_OAUTH_CLIENT_SECRET: 'shh',
        },
        'codebuddy-intl',
        'shipped',
        null,
      ),
    ).toEqual({ clientId: 'mine', clientSecret: 'shh' });
  });

  it('states the one URI rutekit serves', () => {
    expect(redirectPath('qoder')).toBe('/console/api/providers/qoder/oauth/callback');
    expect(redirectUri(ORIGIN, 'qoder')).toBe(
      `${ORIGIN}/console/api/providers/qoder/oauth/callback`,
    );
  });
});

describe('the shipped sign-in providers', () => {
  const IDS = ['codebuddy-intl', 'codebuddy-cn', 'kiro', 'qoder'];

  it('carries a client id and a redirect path rutekit actually serves', () => {
    for (const id of IDS) {
      const auth = oauthAuth(manifest(id));
      expect(auth, `${id} declares no oauth sign-in`).not.toBeNull();
      if (auth === null) continue;
      expect(auth.clientId, `${id} ships no client id`).not.toBe('');
      // A manifest that registered a path nothing answers would throw at the
      // first sign-in, which is a bug the catalogue can catch without a network.
      if (auth.mode === 'oauth-browser') {
        expect(auth.redirectPath, `${id} registers a path rutekit does not serve`).toBe(
          redirectPath(id),
        );
      }
    }
  });
});

describe('the device session', () => {
  /** A scheduler that never fires on its own, so a test drives every poll by hand. */
  function fakeScheduler() {
    const queue: { run: () => void; delayMs: number; cancelled: boolean }[] = [];
    const schedule: Scheduler = (run, delayMs) => {
      const entry = { run, delayMs, cancelled: false };
      queue.push(entry);
      return () => {
        entry.cancelled = true;
      };
    };
    return {
      schedule,
      queue,
      runNext(): void {
        const entry = queue.shift();
        if (entry === undefined) throw new Error('nothing was scheduled');
        entry.run();
      },
    };
  }

  const request = (
    fetch: Fetcher,
    overrides: Partial<Parameters<ReturnType<typeof createDeviceSessions>['start']>[0]> = {},
  ) => ({
    providerId: 'kiro',
    tokenUrl: 'https://p.test/token',
    clientId: 'client-1',
    deviceCode: 'dev-1',
    intervalSeconds: 5,
    expiresAtMs: 100_000,
    fetch,
    now: () => 0,
    onToken: () => {},
    onFailure: () => {},
    ...overrides,
  });

  it('polls on the interval and stops once the token arrives', async () => {
    const scheduler = fakeScheduler();
    const sessions = createDeviceSessions({ schedule: scheduler.schedule });
    const tokens: OauthToken[] = [];
    const { fetch } = fakeFetch(() => reply('{"access_token":"at"}'));

    sessions.start(request(fetch, { onToken: (value) => tokens.push(value) }));

    expect(sessions.size).toBe(1);
    expect(scheduler.queue[0]?.delayMs).toBe(5000);

    scheduler.runNext();
    await flush();

    expect(tokens).toHaveLength(1);
    expect(sessions.size).toBe(0);
  });

  it('asks again when the provider says the approval is pending', async () => {
    const scheduler = fakeScheduler();
    const sessions = createDeviceSessions({ schedule: scheduler.schedule });
    const { fetch } = fakeFetch(() => reply('{"error":"authorization_pending"}', 400));

    sessions.start(request(fetch));
    scheduler.runNext();
    await flush();

    expect(sessions.size).toBe(1);
    expect(scheduler.queue[0]?.delayMs).toBe(5000);
  });

  it('backs off when the provider says slow down', async () => {
    const scheduler = fakeScheduler();
    const sessions = createDeviceSessions({ schedule: scheduler.schedule });
    const { fetch } = fakeFetch(() => reply('{"error":"slow_down"}', 400));

    sessions.start(request(fetch));
    scheduler.runNext();
    await flush();

    expect(scheduler.queue[0]?.delayMs).toBe(10_000);
  });

  it('reports the provider’s own expiry without calling again', async () => {
    const scheduler = fakeScheduler();
    const sessions = createDeviceSessions({ schedule: scheduler.schedule });
    const failures: string[] = [];
    const { fetch, calls } = fakeFetch(() => reply('{"access_token":"at"}'));

    sessions.start(
      request(fetch, { now: () => 200_000, onFailure: (message) => failures.push(message) }),
    );
    scheduler.runNext();
    await flush();

    expect(calls).toHaveLength(0);
    expect(failures).toEqual(['The sign-in code expired before it was approved.']);
  });

  it('abandons an earlier sign-in for the same provider', () => {
    const scheduler = fakeScheduler();
    const sessions = createDeviceSessions({ schedule: scheduler.schedule });
    const { fetch } = fakeFetch(() => reply('{"access_token":"at"}'));

    sessions.start(request(fetch));
    sessions.start(request(fetch));

    expect(scheduler.queue[0]?.cancelled).toBe(true);
    expect(sessions.size).toBe(1);
  });

  it('cancels everything on shutdown, and a stop for an unknown provider is a no-op', () => {
    const scheduler = fakeScheduler();
    const sessions = createDeviceSessions({ schedule: scheduler.schedule });
    const { fetch } = fakeFetch(() => reply('{"access_token":"at"}'));

    sessions.start(request(fetch));
    sessions.stop('nothing-scheduled');
    expect(sessions.size).toBe(1);

    sessions.stopAll();
    expect(sessions.size).toBe(0);
    expect(scheduler.queue[0]?.cancelled).toBe(true);
  });
});

describe('with a database', () => {
  let persistence: Persistence;
  let accounts: ProviderAccountsRepository;
  let box: SecretBox;

  beforeEach(() => {
    persistence = openPersistence({
      databaseUrl: ':memory:',
      dataDir: mkdtempSync(join(tmpdir(), 'rutekit-oauth-')),
    });
    runMigrations(persistence.sqlite);
    accounts = createProviderAccountsRepository(persistence.db);
    box = new SecretBox('ab'.repeat(32));
  });

  afterEach(() => {
    persistence.close();
  });

  describe('where a finished sign-in lands', () => {
    const store = () => createCredentialStore({ accounts, now: () => 1_700_000_000_000 });

    it('encrypts the token and keeps only the masked address beside it', () => {
      const row = store().save(
        box,
        'qoder',
        'oauth-browser',
        token({ idToken: idToken({ email: 'alice@example.com' }) }),
      );

      expect(row.authMode).toBe('oauth-browser');
      expect(row.emailMasked).toBe('a***e@example.com');
      expect(row.label).toBe('a***e@example.com');
      expect(row.state).toBe('active');
      expect(row.maxInFlight).toBe(1);

      // The envelope decrypts to the credential and nothing else — the id token
      // was read for the address and has no business being kept.
      const stored: unknown = JSON.parse(box.decrypt(row.credentialEnvelope));
      expect(stored).toEqual({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        tokenType: 'Bearer',
        scope: 'openid',
        expiresAt: '2026-10-13T01:00:00.000Z',
      });
    });

    it('replaces the account a re-sign-in names rather than adding a row', () => {
      const first = store().save(
        box,
        'qoder',
        'oauth-browser',
        token({ idToken: idToken({ email: 'alice@example.com' }) }),
      );
      store().save(
        box,
        'qoder',
        'oauth-browser',
        token({ accessToken: 'access-2', idToken: idToken({ email: 'alice@example.com' }) }),
      );

      expect(accounts.listByProvider('qoder')).toHaveLength(1);
      const row = accounts.findById(first.id);
      expect(row).not.toBeNull();
      const stored: { accessToken: string } = JSON.parse(
        box.decrypt(row?.credentialEnvelope ?? ''),
      );
      expect(stored.accessToken).toBe('access-2');
    });

    it('labels a nameless sign-in with the provider and inserts each time', () => {
      const first = store().save(box, 'kiro', 'oauth-device', token());
      store().save(box, 'kiro', 'oauth-device', token());

      expect(first.label).toBe('kiro');
      expect(first.emailMasked).toBeNull();
      expect(accounts.listByProvider('kiro')).toHaveLength(2);
    });
  });

  describe('the browser flow', () => {
    const deps = (fetch: Fetcher, overrides: Partial<BrowserFlowDeps> = {}): BrowserFlowDeps => ({
      registry,
      pending: createPendingFlows({ now: () => 0 }),
      secrets: box,
      fetch,
      now: () => 0,
      env: {},
      consoleOrigin: ORIGIN,
      store: createCredentialStore({ accounts, now: () => 0 }),
      ...overrides,
    });

    const browserAuth = () => {
      const auth = oauthAuth(manifest('qoder'));
      if (auth?.mode !== 'oauth-browser') throw new Error('qoder is not a browser flow');
      return auth;
    };

    it('mints a state and a challenge and hands back the consent URL', () => {
      const flow = createBrowserFlow(deps(fakeFetch(() => reply('{}')).fetch));

      const result = flow.start(manifest('qoder'), browserAuth());

      expect(result.started).toBe(true);
      const url = new URL(result.authorizeUrl ?? '');
      expect(url.searchParams.get('client_id')).toBe('qoder-console');
      expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}${redirectPath('qoder')}`);
      expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    });

    it('leaves the challenge out for a manifest that turned PKCE off', () => {
      const flow = createBrowserFlow(deps(fakeFetch(() => reply('{}')).fetch));

      const result = flow.start(manifest('qoder'), { ...browserAuth(), usePkce: false });
      const url = new URL(result.authorizeUrl ?? '');

      expect(url.searchParams.has('code_challenge')).toBe(false);
    });

    it('refuses to start against a path rutekit does not serve', () => {
      const flow = createBrowserFlow(deps(fakeFetch(() => reply('{}')).fetch));

      expect(() =>
        flow.start(manifest('qoder'), { ...browserAuth(), redirectPath: '/elsewhere' }),
      ).toThrow(AppError);
    });

    it('trades the code for a token and stores the account', async () => {
      const fetch = fakeFetch(() =>
        reply(
          JSON.stringify({
            access_token: 'at',
            token_type: 'Bearer',
            expires_in: 3600,
            id_token: idToken({ email: 'alice@example.com' }),
          }),
        ),
      ).fetch;
      const pending = createPendingFlows({ now: () => 0 });
      const flow = createBrowserFlow(deps(fetch, { pending }));

      const started = flow.start(manifest('qoder'), browserAuth());
      const state = new URL(started.authorizeUrl ?? '').searchParams.get('state') ?? '';

      const result = await flow.complete('qoder', 'code-1', state);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.emailMasked).toBe('a***e@example.com');
      expect(accounts.listByProvider('qoder')).toHaveLength(1);
    });

    it('spends a state once, so a replayed callback finds nothing', async () => {
      const fetch = fakeFetch(() => reply('{"access_token":"at"}')).fetch;
      const pending = createPendingFlows({ now: () => 0 });
      const flow = createBrowserFlow(deps(fetch, { pending }));

      const started = flow.start(manifest('qoder'), browserAuth());
      const state = new URL(started.authorizeUrl ?? '').searchParams.get('state') ?? '';

      expect((await flow.complete('qoder', 'code-1', state)).ok).toBe(true);
      const replay = await flow.complete('qoder', 'code-1', state);
      expect(replay).toEqual({
        ok: false,
        message: 'That sign-in has expired, or it was already completed.',
      });
    });

    it('refuses a callback for a provider it was not started for', async () => {
      const pending = createPendingFlows({ now: () => 0 });
      pending.put('state-1', {
        providerId: 'qoder',
        codeVerifier: 'v',
        redirectUri: `${ORIGIN}${redirectPath('qoder')}`,
        createdAtMs: 0,
      });
      const flow = createBrowserFlow(deps(fakeFetch(() => reply('{}')).fetch, { pending }));

      const result = await flow.complete('codebuddy-intl', 'code-1', 'state-1');

      expect(result).toEqual({
        ok: false,
        message: 'That sign-in was started for a different provider.',
      });
    });

    it('refuses a provider that does not sign in through a redirect', async () => {
      const pending = createPendingFlows({ now: () => 0 });
      pending.put('state-1', {
        providerId: 'kiro',
        codeVerifier: null,
        redirectUri: `${ORIGIN}${redirectPath('kiro')}`,
        createdAtMs: 0,
      });
      const flow = createBrowserFlow(deps(fakeFetch(() => reply('{}')).fetch, { pending }));

      const result = await flow.complete('kiro', 'code-1', 'state-1');

      expect(result.ok).toBe(false);
    });

    it('refuses to finish when there is nowhere to store the credential', async () => {
      const pending = createPendingFlows({ now: () => 0 });
      pending.put('state-1', {
        providerId: 'qoder',
        codeVerifier: 'v',
        redirectUri: `${ORIGIN}${redirectPath('qoder')}`,
        createdAtMs: 0,
      });
      const flow = createBrowserFlow(
        deps(fakeFetch(() => reply('{"access_token":"at"}')).fetch, { pending, secrets: null }),
      );

      const result = await flow.complete('qoder', 'code-1', 'state-1');

      expect(result).toEqual({ ok: false, message: NO_KEY_MESSAGE });
    });
  });

  describe('the service the route calls', () => {
    const build = (fetch: Fetcher, secrets: SecretBox | null = box) =>
      createProviderOauthService({
        registry,
        accounts,
        secrets,
        pending: createPendingFlows({ now: () => 0 }),
        logger: silentLogger(),
        consoleOrigin: ORIGIN,
        fetch,
        env: {},
        now: () => 0,
        // No timer: these tests are about what `start` answers, not the poll.
        sessions: createDeviceSessions({ schedule: () => () => {} }),
      });

    it('starts a browser sign-in and hands back a URL to open', async () => {
      const service = build(fakeFetch(() => reply('{}')).fetch);

      const result = await service.start('qoder');

      expect(result.started).toBe(true);
      expect(result.authorizeUrl).not.toBeNull();
      expect(result.message).toContain('Qoder');
    });

    it('starts a device sign-in and puts the user code in the sentence', async () => {
      const { fetch } = fakeFetch(() =>
        reply(
          JSON.stringify({
            device_code: 'dev-1',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://kiro.dev/device',
            interval: 5,
            expires_in: 600,
          }),
        ),
      );
      const service = build(fetch);

      const result = await service.start('kiro');

      expect(result.started).toBe(true);
      expect(result.authorizeUrl).toBe('https://kiro.dev/device');
      expect(result.message).toContain('ABCD-EFGH');
    });

    it('answers a device start the endpoint refused without throwing', async () => {
      const service = build(fakeFetch(() => reply('{"error":"invalid_client"}', 400)).fetch);

      const result = await service.start('kiro');

      expect(result.started).toBe(false);
      expect(result.authorizeUrl).toBeNull();
    });

    it('throws for a provider it does not know and one with no sign-in', async () => {
      const service = build(fakeFetch(() => reply('{}')).fetch);

      await expect(service.start('nope')).rejects.toThrow('No provider with id nope.');
      await expect(service.start('groq')).rejects.toThrow(AppError);
    });

    it('throws when the instance has no encryption key to store under', async () => {
      const service = build(fakeFetch(() => reply('{}')).fetch, null);

      await expect(service.start('qoder')).rejects.toThrow(NO_KEY_MESSAGE);
    });
  });
});

describe('the routes', () => {
  /**
   * The two routes as the console and the browser reach them, through `buildApp`
   * and the real stage order. The test server is built with no encryption key, so
   * the start route can be seen answering every failure it owns without a socket:
   * a provider that is missing, one with no sign-in, and the instance that cannot
   * store what it is about to be given.
   */
  const startPath = (id: string) => consolePath(consolePaths.providerOauth, { id });
  const callbackPath = (id: string) => consolePath(consolePaths.providerOauthCallback, { id });

  let server: TestServer;

  beforeEach(() => {
    server = makeServer();
  });

  afterEach(() => {
    server.close();
  });

  async function signIn(app: ReturnType<typeof buildApp>): Promise<string> {
    const response = await app.request(`${CONSOLE_API_PREFIX}${consolePaths.authSetup}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct-horse-battery', instanceName: 'Test' }),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie === null) throw new Error('setup did not set a session cookie');
    const pair = setCookie.split(';')[0];
    if (pair === undefined) throw new Error('empty set-cookie header');
    return pair;
  }

  async function kindOf(response: Response): Promise<string> {
    return consoleErrorSchema.parse(await response.json()).error.kind;
  }

  /** The outcome the callback wrote into the query string it redirected to. */
  function outcomeOf(response: Response): string | null {
    return new URL(response.headers.get('location') ?? '').searchParams.get('oauth');
  }

  it('turns away a start with no session', async () => {
    const app = buildApp(server);
    server.lifecycle.markReady();

    const response = await app.request(startPath('qoder'), { method: 'POST' });

    expect(response.status).toBe(401);
  });

  it('answers 404 for a provider the catalogue does not have', async () => {
    const app = buildApp(server);
    server.lifecycle.markReady();
    const cookie = await signIn(app);

    const response = await app.request(startPath('nope'), {
      method: 'POST',
      headers: { cookie },
    });

    expect(response.status).toBe(404);
    expect(await kindOf(response)).toBe('not_found');
  });

  it('answers 400 for a provider with no sign-in to start', async () => {
    const app = buildApp(server);
    server.lifecycle.markReady();
    const cookie = await signIn(app);

    const response = await app.request(startPath('groq'), {
      method: 'POST',
      headers: { cookie },
    });

    expect(response.status).toBe(400);
    expect(await kindOf(response)).toBe('invalid_request');
  });

  it('answers 503 when the instance has no key to store a credential under', async () => {
    const app = buildApp(server);
    server.lifecycle.markReady();
    const cookie = await signIn(app);

    const response = await app.request(startPath('qoder'), {
      method: 'POST',
      headers: { cookie },
    });

    expect(response.status).toBe(503);
    expect(await kindOf(response)).toBe('unavailable');
  });

  it('sends a refused sign-in back to the provider page as an error', async () => {
    const app = buildApp(server);
    server.lifecycle.markReady();
    const cookie = await signIn(app);

    const response = await app.request(`${callbackPath('qoder')}?error=access_denied`, {
      headers: { cookie },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/providers/qoder');
    expect(outcomeOf(response)).toBe('error');
  });

  it('sends a callback missing its code or state back as an error', async () => {
    const app = buildApp(server);
    server.lifecycle.markReady();
    const cookie = await signIn(app);

    const response = await app.request(callbackPath('qoder'), { headers: { cookie } });

    expect(response.status).toBe(302);
    expect(outcomeOf(response)).toBe('error');
  });

  it('sends a callback with nothing pending back as an error', async () => {
    const app = buildApp(server);
    server.lifecycle.markReady();
    const cookie = await signIn(app);

    const response = await app.request(`${callbackPath('qoder')}?code=code-1&state=state-1`, {
      headers: { cookie },
    });

    expect(response.status).toBe(302);
    expect(outcomeOf(response)).toBe('error');
  });
});
