import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProviderRegistry } from '@registry';
import { providerManifests } from '@registry/providers/index.ts';

import { createIdFactory } from '@shared';

import { silentLogger } from '@server/observability/logger.ts';
import { nodeCrypto } from '@server/providers/codec-crypto.ts';
import { openPersistence, type Persistence } from '@server/persistence/client.ts';
import { runMigrations } from '@server/persistence/migrate.ts';
import {
  createProviderAccountsRepository,
  type ProviderAccountsRepository,
} from '@server/persistence/provider-accounts.ts';
import { createWarmup, type Warmup } from '@server/pool/warmup.ts';
import type { ResponseFetcher } from '@server/providers/outbound.ts';
import { parseConfig } from '@server/runtime/config.ts';
import { SecretBox } from '@server/security/secret-box.ts';

/**
 * The warmup check-in (FR-3.5, FR-3.6).
 *
 * The probe is one authenticated GET, so the tests are about what a status means
 * for the account it came from and about the sweep's bookkeeping — one at a time,
 * the `checking` flag, the timestamp. The fetch is a stub, because the subject is
 * what the warmup does with an answer, not the network.
 *
 * `openai` is the provider under test: a fixed `baseUrl`, an API-key credential,
 * and a `/models` listing, which is exactly the shape the probe is written for.
 */

const KEY = 'ab'.repeat(32);
const AT = new Date('2026-10-13T12:00:00.000Z');

let persistence: Persistence;
let accounts: ProviderAccountsRepository;
let box: SecretBox;
let clock: Date;

beforeEach(() => {
  persistence = openPersistence({
    databaseUrl: ':memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'rutekit-warmup-')),
  });
  runMigrations(persistence.sqlite);
  accounts = createProviderAccountsRepository(persistence.db);
  box = new SecretBox(KEY);
  clock = new Date(AT);
});

afterEach(() => {
  persistence.close();
});

function seed(providerId = 'openai', state = 'active', credential = 'sk-test'): string {
  const id = crypto.randomUUID();
  const at = AT.toISOString();
  accounts.create({
    id,
    providerId,
    label: 'account',
    credentialEnvelope: box.encrypt(credential),
    authMode: 'api-key',
    state,
    createdAt: at,
    updatedAt: at,
  });
  return id;
}

/** A fetch whose answers are scripted per URL, recording every call it is asked to make. */
function stubFetch(
  answer: (url: string, init: RequestInit | undefined) => Promise<Response> | Response,
): ResponseFetcher & { readonly calls: string[] } {
  const calls: string[] = [];
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(url);
    return await answer(url, init);
  };
  return Object.assign(fetcher, { calls });
}

function ok(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 200, headers });
}

function makeWarmup(fetch: ResponseFetcher, intervalMs = 60_000): Warmup {
  const config = parseConfig(
    {
      RUTEKIT_DATABASE_URL: ':memory:',
      RUTEKIT_WARMUP_INTERVAL_MS: String(intervalMs),
    },
    process.cwd(),
  );
  return createWarmup({
    registry: createProviderRegistry(providerManifests),
    accounts,
    secrets: box,
    fetch,
    config,
    logger: silentLogger(),
    ids: createIdFactory((bytes) => crypto.getRandomValues(new Uint8Array(bytes))),
    crypto: nodeCrypto,
    now: () => clock,
  });
}

describe('the probe', () => {
  it('proves the credential lives without disturbing an active account', async () => {
    const id = seed();
    const fetch = stubFetch(() => ok());
    const warmup = makeWarmup(fetch);

    await warmup.checkIn(['openai']);

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toBe('https://api.openai.com/v1/models');
    expect(accounts.findById(id)?.state).toBe('active');
  });

  it('sends the credential the way the provider asks for it', async () => {
    seed();
    let seen: RequestInit | undefined;
    const warmup = makeWarmup(
      stubFetch((_url, init) => {
        seen = init;
        return ok();
      }),
    );

    await warmup.checkIn(['openai']);

    const headers = new Headers(seen?.headers);
    expect(headers.get('authorization')).toBe('Bearer sk-test');
  });

  it('records the quota a 200 reported', async () => {
    const id = seed();
    const warmup = makeWarmup(
      stubFetch(() =>
        ok({
          'x-ratelimit-limit-requests': '1000',
          'x-ratelimit-remaining-requests': '940',
          'x-ratelimit-reset-requests': '2026-10-13T13:00:00.000Z',
        }),
      ),
    );

    await warmup.checkIn(['openai']);

    const row = accounts.findById(id);
    expect(row?.quotaLimit).toBe(1000);
    expect(row?.quotaRemaining).toBe(940);
    expect(row?.quotaResetAt).toBe('2026-10-13T13:00:00.000Z');
    // The window is derived from the reset the provider named, not stated.
    expect(row?.quotaWindowSeconds).toBe(3600);
  });

  it('leaves the quota columns alone when the provider publishes none', async () => {
    const id = seed();
    const warmup = makeWarmup(stubFetch(() => ok()));

    await warmup.checkIn(['openai']);

    expect(accounts.findById(id)?.quotaLimit).toBeNull();
  });

  it('bans an account the provider refused', async () => {
    const id = seed();
    const warmup = makeWarmup(stubFetch(() => new Response(null, { status: 401 })));

    await warmup.checkIn(['openai']);

    expect(accounts.findById(id)?.state).toBe('banned');
  });

  it('rests an account the provider rate-limited, honouring its retry-after', async () => {
    const id = seed();
    const warmup = makeWarmup(
      stubFetch(() => new Response(null, { status: 429, headers: { 'retry-after': '90' } })),
    );

    await warmup.checkIn(['openai']);

    const row = accounts.findById(id);
    expect(row?.state).toBe('rate_limited');
    expect(row?.cooldownUntil).toBe('2026-10-13T12:01:30.000Z');
  });

  it('advances the streak on a 5xx without parking the account', async () => {
    const id = seed();
    const warmup = makeWarmup(stubFetch(() => new Response(null, { status: 503 })));

    await warmup.checkIn(['openai']);

    const row = accounts.findById(id);
    expect(row?.state).toBe('active');
    expect(row?.consecutiveFailures).toBe(1);
  });

  it('brings a parked account back when the probe succeeds', async () => {
    const id = seed('openai', 'error');
    const warmup = makeWarmup(stubFetch(() => ok()));

    await warmup.checkIn(['openai']);

    expect(accounts.findById(id)?.state).toBe('active');
  });

  it('treats an unreachable provider as transient rather than a credential problem', async () => {
    const id = seed();
    const warmup = makeWarmup(
      stubFetch(() => {
        throw new Error('connect ECONNREFUSED');
      }),
    );

    // The caller is a timer, so a probe that throws must not reject the sweep.
    await expect(warmup.checkIn(['openai'])).resolves.toBeUndefined();

    const row = accounts.findById(id);
    expect(row?.state).toBe('active');
    expect(row?.consecutiveFailures).toBe(1);
  });

  it('never moves an account an operator disabled', async () => {
    const id = seed('openai', 'disabled');
    const warmup = makeWarmup(stubFetch(() => ok()));

    await warmup.checkIn(['openai']);

    expect(accounts.findById(id)?.state).toBe('disabled');
  });

  it('probes only the providers it was asked for', async () => {
    seed('openai');
    seed('anthropic');
    const fetch = stubFetch(() => ok());
    const warmup = makeWarmup(fetch);

    await warmup.checkIn(['anthropic']);

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toContain('anthropic.com');
  });
});

describe('the sweep’s bookkeeping', () => {
  it('stamps the check-in time only after a run that had targets', async () => {
    seed();
    const warmup = makeWarmup(stubFetch(() => ok()));

    expect(warmup.lastCheckedAt()).toBeNull();

    await warmup.checkIn(['openai']);
    expect(warmup.lastCheckedAt()).toBe(clock.toISOString());
  });

  it('leaves the timestamp alone when the run had no targets', async () => {
    const warmup = makeWarmup(stubFetch(() => ok()));

    await warmup.checkIn(['not-a-provider']);

    expect(warmup.lastCheckedAt()).toBeNull();
  });

  it('reports the provider as checking while the probe is in flight', async () => {
    seed();
    // A holder rather than a bare `let`: the executor runs synchronously, but
    // TypeScript cannot see that, and a narrowed `null` would not be callable.
    const gate: { open: (() => void) | null } = { open: null };
    const blocked = new Promise<void>((resolve) => {
      gate.open = resolve;
    });
    const warmup = makeWarmup(
      stubFetch(async () => {
        await blocked;
        return ok();
      }),
    );

    const sweep = warmup.checkIn(['openai']);
    // Yield once so the sweep reaches its first await and marks the provider.
    await Promise.resolve();

    expect(warmup.checking().has('openai')).toBe(true);
    gate.open?.();
    await sweep;
    expect(warmup.checking().size).toBe(0);
  });

  it('ignores a second check-in while one is already running', async () => {
    seed();
    const gate: { open: (() => void) | null } = { open: null };
    const blocked = new Promise<void>((resolve) => {
      gate.open = resolve;
    });
    const fetch = stubFetch(async () => {
      await blocked;
      return ok();
    });
    const warmup = makeWarmup(fetch);

    const first = warmup.checkIn(['openai']);
    await Promise.resolve();
    // The sweep already covers every provider, so the second pass would only
    // double the traffic — it returns at once instead.
    await warmup.checkIn(['openai']);

    expect(fetch.calls).toHaveLength(1);
    gate.open?.();
    await first;
  });
});

/**
 * Stopping mid-sweep.
 *
 * `stop()` clears the interval, which handles the next sweep but not the one
 * already running — and a running sweep is a sequence of network round trips
 * with database reads on both sides of each. Shutdown calls `warmup.stop()`
 * before `persistence.close()`, so a probe that ignored the stop would carry on
 * reading a database that is about to be closed underneath it. That surfaced as
 * `RangeError: Cannot use a closed database`, thrown from a timer nothing was
 * watching — an unhandled rejection vitest reports as a possible source of false
 * positives, which is exactly what it was.
 */
describe('stopping mid-sweep', () => {
  /** Park the probe inside the fetch, so `stop()` lands between read and write. */
  function gated(answer: () => Response | Promise<Response>): {
    fetch: ResponseFetcher;
    release: () => void;
  } {
    const gate: { open: (() => void) | null } = { open: null };
    const blocked = new Promise<void>((resolve) => {
      gate.open = resolve;
    });
    const fetch = stubFetch(async () => {
      await blocked;
      return await answer();
    });
    return { fetch, release: () => gate.open?.() };
  }

  it('does not park an account on an answer that arrived after the stop', async () => {
    // A 401 is the sharpest observable there is: the probe's own policy turns it
    // into `banned`, so an account still `active` afterwards is proof the write
    // never happened. Asserting a field a success leaves alone would pass whether
    // the guard existed or not.
    const id = seed();
    const { fetch, release } = gated(() => new Response(null, { status: 401 }));
    const warmup = makeWarmup(fetch);

    const sweep = warmup.checkIn(['openai']);
    await Promise.resolve();
    warmup.stop();
    release();
    await sweep;

    expect(accounts.findById(id)?.state).toBe('active');
  });

  it('does not write a quota window that arrived after the stop', async () => {
    const id = seed();
    const { fetch, release } = gated(
      () => new Response(null, { status: 200, headers: { 'x-ratelimit-remaining-requests': '9' } }),
    );
    const warmup = makeWarmup(fetch);

    const sweep = warmup.checkIn(['openai']);
    await Promise.resolve();
    warmup.stop();
    release();
    await sweep;

    expect(accounts.findById(id)?.quotaRemaining).toBeNull();
  });

  it('does not stamp a check-in that was cut short', async () => {
    seed();
    const { fetch, release } = gated(() => ok());
    const warmup = makeWarmup(fetch);

    const sweep = warmup.checkIn(['openai']);
    await Promise.resolve();
    warmup.stop();
    release();
    await sweep;

    // `lastCheckedAt` says "the accounts were checked", and a stopped sweep did
    // not check them — a timestamp here would have the console report a check-in
    // that never finished.
    expect(warmup.lastCheckedAt()).toBeNull();
  });

  it('does not record a stop as an unreachable provider', async () => {
    const id = seed();
    const { fetch, release } = gated(() => {
      throw new Error('aborted');
    });
    const warmup = makeWarmup(fetch);

    const sweep = warmup.checkIn(['openai']);
    await Promise.resolve();
    warmup.stop();
    release();
    await sweep;

    // A rejected fetch is the shape a real abort takes. Recording it as
    // `transient` would advance a failure streak for an account nothing is wrong
    // with — the probe never reached the provider at all.
    expect(accounts.findById(id)?.consecutiveFailures).toBe(0);
  });

  it('probes again on a check-in after a stop', async () => {
    // The generation counter must not turn into a one-way latch: a warmup that
    // was stopped and then asked to check in again has to work.
    seed();
    const fetch = stubFetch(() => ok());
    const warmup = makeWarmup(fetch);

    warmup.stop();
    await warmup.checkIn(['openai']);

    expect(fetch.calls).toHaveLength(1);
    expect(warmup.lastCheckedAt()).not.toBeNull();
  });
});

describe('the interval', () => {
  it('reports no next sweep before it has started', () => {
    const warmup = makeWarmup(stubFetch(() => ok()));
    expect(warmup.nextSweepInSeconds()).toBeNull();
  });

  it('reports a next sweep once started, and none again after stop', () => {
    const warmup = makeWarmup(
      stubFetch(() => ok()),
      120_000,
    );

    warmup.start();
    expect(warmup.nextSweepInSeconds()).toBe(120);

    warmup.stop();
    expect(warmup.nextSweepInSeconds()).toBeNull();
  });

  it('does not arm a second timer when started twice', () => {
    const warmup = makeWarmup(
      stubFetch(() => ok()),
      120_000,
    );

    warmup.start();
    clock = new Date(AT.getTime() + 60_000);
    warmup.start();
    // Still measured from the first start: the second call was a no-op.
    expect(warmup.nextSweepInSeconds()).toBe(60);

    warmup.stop();
  });
});

/**
 * A provider whose models are curated, not listed.
 *
 * **This block exists because twelve providers had no probe at all.** Their
 * discovery is `static`, so `listingPath` returned null, `probeRequest` returned
 * null, and the sweep skipped them without a word. An account imported by
 * automation therefore stayed `pending` for ever — and `pending` is not routable,
 * so it existed, had cost a browser sign-in, and could never take a turn.
 *
 * The fix is a `probePath` a manifest can name, which is what these tests hold to.
 */
describe('a provider that has no listing', () => {
  it('probes the path the manifest names instead of skipping the account', async () => {
    const id = seed('qoder', 'pending', 'qoder-token');
    const fetch = stubFetch(() => ok());
    const warmup = makeWarmup(fetch);

    await warmup.checkIn(['qoder']);

    // The probe reached the provider, which is the thing that never happened.
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toBe('https://openapi.qoder.sh/api/v2/quota/usage');
    // And the account is now usable: a 200 proves the credential, which is what
    // `pending` was waiting for.
    expect(accounts.findById(id)?.state).toBe('active');
  });

  it('promotes an imported account on its first successful probe', async () => {
    // The end-to-end consequence, stated as its own assertion: a fresh import is
    // `pending`, one probe makes it `active`, and only then may routing select it.
    const id = seed('kiro', 'pending', 'kiro-token');
    expect(accounts.findById(id)?.state).toBe('pending');

    const warmup = makeWarmup(stubFetch(() => ok()));
    await warmup.checkIn(['kiro']);

    expect(accounts.findById(id)?.state).toBe('active');
  });

  it('does not promote on a probe endpoint that does not exist', async () => {
    // A 404 is the probe aimed at the wrong path, not the credential being good.
    // Reading it as success is how a wrong host promoted every imported account
    // into the rotation without anything having been verified.
    const id = seed('qoder', 'pending', 'token');
    const warmup = makeWarmup(stubFetch(() => new Response(null, { status: 404 })));

    await warmup.checkIn(['qoder']);

    expect(accounts.findById(id)?.state).toBe('pending');
  });

  it('still parks a credential the provider rejects', async () => {
    // Promotion is not credulity: a 401 is the provider saying the credential is
    // dead, and that has to move the account out of the rotation.
    const id = seed('qoder', 'pending', 'dead-token');
    const warmup = makeWarmup(stubFetch(() => new Response(null, { status: 401 })));

    await warmup.checkIn(['qoder']);

    expect(accounts.findById(id)?.state).toBe('banned');
  });

  it('probes a local runner at its own base URL', async () => {
    // A provider with no listing and no named probe path is not skipped: its base
    // URL is still something to ask, and for a local runner that is the whole
    // check. What the old code did here was return null and move on, which for a
    // curated provider meant its accounts were never looked at at all.
    const id = seed('comfyui-local', 'pending', 'whatever');
    const fetch = stubFetch(() => ok());
    const warmup = makeWarmup(fetch);

    await warmup.checkIn(['comfyui-local']);

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toBe('http://127.0.0.1:8188');
    expect(accounts.findById(id)?.state).toBe('active');
  });
});

describe('a refusal that a renewal can undo', () => {
  /**
   * kiro answers 403 both for an expired access token and for a suspended
   * account, so the status alone cannot tell them apart — and reading it as final
   * banned every kiro account a few hours after import. `banned` is a state only
   * an operator can leave, so a clock turned a renewable credential into a re-run
   * of browser automation.
   *
   * The refresh is spent only after a refusal, never before every probe: a
   * check-in runs on a timer, and rotating a token that still works would
   * multiply the provider's refresh traffic by the sweep interval for nothing.
   */

  const REFRESH = 'https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken';

  function seedKiro(state = 'active', refreshToken = 'refresh-1'): string {
    return seed(
      'kiro',
      state,
      JSON.stringify({ accessToken: 'expired-token', refreshToken, profileArn: 'arn:aws:x' }),
    );
  }

  /** A fetch that answers by URL, so the probe and the refresh can differ. */
  function routedFetch(
    answers: { probe: (call: number) => Response; refresh: () => Response },
  ): ResponseFetcher & { readonly calls: string[] } {
    let probes = 0;
    return stubFetch((url) => {
      if (url === REFRESH) return answers.refresh();
      probes += 1;
      return answers.probe(probes);
    });
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('renews and asks again, so an expired token does not ban the account', async () => {
    const id = seedKiro();
    const fetch = routedFetch({
      probe: (call) => (call === 1 ? new Response(null, { status: 403 }) : ok()),
      refresh: () => json({ accessToken: 'fresh-token', refreshToken: 'refresh-2' }),
    });

    await makeWarmup(fetch).checkIn(['kiro']);

    expect(fetch.calls.filter((url) => url === REFRESH)).toHaveLength(1);
    expect(fetch.calls).toHaveLength(3);
    expect(accounts.findById(id)?.state).toBe('active');
  });

  it('stores the renewed token, because the next turn spends it', async () => {
    const id = seedKiro();
    const fetch = routedFetch({
      probe: (call) => (call === 1 ? new Response(null, { status: 401 }) : ok()),
      refresh: () => json({ accessToken: 'fresh-token', refreshToken: 'refresh-2' }),
    });

    await makeWarmup(fetch).checkIn(['kiro']);

    const stored = JSON.parse(box.decrypt(accounts.findById(id)?.credentialEnvelope ?? ''));
    expect(stored.accessToken).toBe('fresh-token');
    // The rotated token is the one that still works; keeping the old one would
    // make the next renewal spend a token the provider has already retired.
    expect(stored.refreshToken).toBe('refresh-2');
    // Fields the provider did not send back are still true and must survive.
    expect(stored.profileArn).toBe('arn:aws:x');
  });

  it('bans the account when the renewal is refused too', async () => {
    // A suspended account and an expired token look identical from the outside;
    // once the refresh token is refused as well, the credential really is dead
    // and the account must not sit as `active` waiting for a turn to fail.
    const id = seedKiro();
    const fetch = routedFetch({
      probe: () => new Response(null, { status: 403 }),
      refresh: () => new Response(null, { status: 400 }),
    });

    await makeWarmup(fetch).checkIn(['kiro']);

    expect(accounts.findById(id)?.state).toBe('banned');
    expect(accounts.findById(id)?.stateReason).toBe('The provider rejected this credential.');
  });

  it('bans the account when the renewal succeeds and the retry is still refused', async () => {
    const id = seedKiro();
    const fetch = routedFetch({
      probe: () => new Response(null, { status: 403 }),
      refresh: () => json({ accessToken: 'fresh-token' }),
    });

    await makeWarmup(fetch).checkIn(['kiro']);

    expect(fetch.calls.filter((url) => url === REFRESH)).toHaveLength(1);
    expect(accounts.findById(id)?.state).toBe('banned');
  });

  it('never renews a credential that was not refused', async () => {
    // A token that works is left alone: a sweep runs every few minutes for every
    // account, and rotating on each one would be pure refresh traffic.
    seedKiro();
    const fetch = routedFetch({
      probe: () => ok(),
      refresh: () => json({ accessToken: 'unused' }),
    });

    await makeWarmup(fetch).checkIn(['kiro']);

    expect(fetch.calls).not.toContain(REFRESH);
    expect(fetch.calls).toHaveLength(1);
  });

  it('leaves a provider with no refresh policy alone', async () => {
    const id = seed('openai', 'active', 'sk-dead');
    const fetch = stubFetch(() => new Response(null, { status: 403 }));

    await makeWarmup(fetch).checkIn(['openai']);

    expect(fetch.calls).toHaveLength(1);
    expect(accounts.findById(id)?.state).toBe('banned');
  });
});

describe('a provider that states its limits in the body', () => {
  /**
   * qoder's usage endpoint answers `{userQuota, isQuotaExceeded}` and no
   * rate-limit headers at all, so a probe that read only headers learned nothing
   * about any qoder account: the console showed no balance and the operator had
   * no way to see a plan that had spent its allowance.
   *
   * The mapping is the manifest's — paths, not code — so this exercises the
   * mechanism through a manifest rather than through qoder's own numbers.
   */

  function seedWithBody(state = 'pending'): string {
    return seed('qoder', state, JSON.stringify({ securityOauthToken: 't', userId: 'u' }));
  }

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('records the balance the body reported', async () => {
    const id = seedWithBody();
    const warmup = makeWarmup(
      stubFetch(() =>
        json({
          userQuota: { total: 500, used: 120, remaining: 380 },
          isQuotaExceeded: false,
          expiresAt: Date.parse('2026-10-13T13:00:00.000Z'),
        }),
      ),
    );

    await warmup.checkIn(['qoder']);

    const row = accounts.findById(id);
    expect(row?.quotaLimit).toBe(500);
    expect(row?.quotaRemaining).toBe(380);
    expect(row?.quotaResetAt).toBe('2026-10-13T13:00:00.000Z');
  });

  it('still reads headers for a provider that declares no body', async () => {
    // The common case, and it must not regress: reading a body nobody meant to
    // be read would spend the round trip on nothing.
    const id = seed();
    const warmup = makeWarmup(
      stubFetch(() => ok({ 'x-ratelimit-limit-requests': '100', 'x-ratelimit-remaining-requests': '90' })),
    );

    await warmup.checkIn(['openai']);

    expect(accounts.findById(id)?.quotaLimit).toBe(100);
    expect(accounts.findById(id)?.quotaRemaining).toBe(90);
  });
});
