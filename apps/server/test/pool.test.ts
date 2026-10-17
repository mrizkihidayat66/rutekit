import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoadBalanceStrategy } from '@contracts';
import { createProviderRegistry } from '@registry';
import { providerManifests } from '@registry/providers/index.ts';

import { AppError } from '@server/errors.ts';
import { silentLogger } from '@server/observability/logger.ts';
import { openPersistence, type Persistence } from '@server/persistence/client.ts';
import { runMigrations } from '@server/persistence/migrate.ts';
import {
  createProviderAccountsRepository,
  type ProviderAccountsRepository,
} from '@server/persistence/provider-accounts.ts';
import { createPool, type AccountLease, type Pool } from '@server/pool/pool.ts';
import { SecretBox } from '@server/security/secret-box.ts';

/**
 * The account pool (FR-3.1–3.4, ADR-0020).
 *
 * Against a real SQLite row, because the pool's whole job is a read of the
 * account store followed by a write to it, and the in-flight count it keeps is
 * only meaningful next to the rows it is choosing among.
 *
 * The clock is fixed and handed in, so a cooldown is a number rather than a
 * sleep, and `sweep` can be asked what it would do at a moment of the test's
 * choosing.
 */

const KEY = 'ab'.repeat(32);
const START = new Date('2026-10-13T12:00:00.000Z');

let persistence: Persistence;
let accounts: ProviderAccountsRepository;
let box: SecretBox;
let clock: Date;

beforeEach(() => {
  persistence = openPersistence({
    databaseUrl: ':memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'rutekit-pool-')),
  });
  runMigrations(persistence.sqlite);
  accounts = createProviderAccountsRepository(persistence.db);
  box = new SecretBox(KEY);
  clock = new Date(START);
});

afterEach(() => {
  persistence.close();
});

interface SeedOptions {
  readonly id?: string;
  readonly providerId?: string;
  readonly state?: string;
  readonly maxInFlight?: number;
  readonly credential?: string | null;
  readonly cooldownUntil?: string | null;
  readonly quotaResetAt?: string | null;
}

function seed(options: SeedOptions = {}): string {
  const id = options.id ?? crypto.randomUUID();
  const at = START.toISOString();
  accounts.create({
    id,
    providerId: options.providerId ?? 'openai',
    label: 'account',
    credentialEnvelope: box.encrypt(options.credential ?? 'sk-test'),
    authMode: 'api-key',
    state: options.state ?? 'active',
    maxInFlight: options.maxInFlight ?? 1,
    cooldownUntil: options.cooldownUntil ?? null,
    quotaResetAt: options.quotaResetAt ?? null,
    createdAt: at,
    updatedAt: at,
  });
  return id;
}

function makePool(
  strategy: LoadBalanceStrategy = 'round_robin',
  secrets: SecretBox | null = box,
): Pool {
  return createPool({
    registry: createProviderRegistry(providerManifests),
    accounts,
    secrets,
    strategy: () => strategy,
    logger: silentLogger(),
    now: () => clock,
  });
}

/** The lease a call must have produced, or a failure that names the test's own mistake. */
function take(pool: Pool, providerId = 'openai'): AccountLease {
  const outcome = pool.acquire(providerId);
  if (!outcome.ok) throw new Error(`expected a lease, got ${outcome.reason}`);
  return outcome.lease;
}

describe('createPool.acquire', () => {
  it('answers null when the provider has no accounts', () => {
    expect(makePool().acquire('openai').ok).toBe(false);
  });

  it('answers null when no account is in a routable state', () => {
    seed({ state: 'pending' });
    seed({ state: 'disabled' });
    seed({ state: 'rate_limited' });

    expect(makePool().acquire('openai').ok).toBe(false);
  });

  it('hands back a credential for an active account', () => {
    const id = seed({ credential: 'sk-live' });

    const lease = take(makePool());
    expect(lease?.accountId).toBe(id);
    expect(lease?.credential.value).toBe('sk-live');
  });

  it('counts the lease while it is held', () => {
    seed();
    const pool = makePool();

    const lease = take(pool);
    expect(lease).not.toBeNull();
    expect(pool.inFlight(lease?.accountId ?? '')).toBe(1);
  });

  it('refuses a second turn once an account is at its ceiling', () => {
    seed({ maxInFlight: 1 });
    const pool = makePool();

    expect(pool.acquire('openai').ok).toBe(true);
    // Nothing left to take: the one account is full and there is no sibling.
    expect(pool.acquire('openai').ok).toBe(false);
  });

  it('spreads turns across siblings up to each one’s ceiling', () => {
    seed({ id: 'a', maxInFlight: 1 });
    seed({ id: 'b', maxInFlight: 1 });
    const pool = makePool('round_robin');

    const first = take(pool);
    const second = take(pool);
    expect([first?.accountId, second?.accountId]).toEqual(['a', 'b']);
    expect(pool.acquire('openai').ok).toBe(false);
  });

  it('skips an account whose credential will not decrypt', () => {
    const id = seed();
    // A second box with a different key: the row's envelope is unreadable to it.
    const pool = makePool('round_robin', new SecretBox('cd'.repeat(32)));

    expect(pool.acquire('openai').ok).toBe(false);
    expect(pool.inFlight(id)).toBe(0);
  });

  it('answers null when no key is configured at all', () => {
    seed();
    expect(makePool('round_robin', null).acquire('openai').ok).toBe(false);
  });

  it('only ever considers the provider asked for', () => {
    seed({ id: 'openai-1', providerId: 'openai' });
    seed({ id: 'anthropic-1', providerId: 'anthropic' });
    const pool = makePool();

    expect(take(pool, 'anthropic').accountId).toBe('anthropic-1');
  });

  it('rotates through the siblings across turns', () => {
    seed({ id: 'a', maxInFlight: 5 });
    seed({ id: 'b', maxInFlight: 5 });
    const pool = makePool('round_robin');

    const taken = [take(pool), take(pool), take(pool)].map((lease) => lease.accountId);
    expect(taken).toEqual(['a', 'b', 'a']);
  });

  it('honours the sequential strategy’s stated order', () => {
    seed({ id: 'a', maxInFlight: 5 });
    seed({ id: 'b', maxInFlight: 5 });
    const pool = makePool('sequential');

    expect(take(pool).accountId).toBe('a');
    expect(take(pool).accountId).toBe('a');
  });
});

describe('settling a lease', () => {
  it('releases the in-flight count on success and stamps the use', () => {
    const id = seed();
    const pool = makePool();

    const lease = take(pool);
    lease.succeed();

    expect(pool.inFlight(id)).toBe(0);
    expect(accounts.findById(id)?.lastUsedAt).toBe(clock.toISOString());
  });

  it('releases the in-flight count on failure', () => {
    const id = seed();
    const pool = makePool();

    take(pool).fail(AppError.upstreamError('boom'));

    expect(pool.inFlight(id)).toBe(0);
  });

  it('parks an account the provider rate-limited, with the cooldown it named', () => {
    const id = seed();
    const pool = makePool();

    take(pool).fail(AppError.rateLimit(45));

    const row = accounts.findById(id);
    expect(row?.state).toBe('rate_limited');
    expect(row?.cooldownUntil).toBe('2026-10-13T12:00:45.000Z');
  });

  it('settles only once, so a stream that dies cannot leak capacity', () => {
    const id = seed();
    const pool = makePool();

    const lease = take(pool);
    lease.succeed();
    // A second settle is a no-op: without this, a stream that ended after its
    // headers would decrement the count a second time and free a slot twice.
    lease?.fail(AppError.upstreamError('late failure'));
    lease?.succeed();

    expect(pool.inFlight(id)).toBe(0);
    expect(accounts.findById(id)?.state).toBe('active');
  });

  it('frees the slot again once a settled account is asked for', () => {
    seed();
    const pool = makePool();

    take(pool).succeed();
    expect(pool.acquire('openai').ok).toBe(true);
  });
});

describe('createPool.sweep', () => {
  it('brings a rate-limited account back once its cooldown has passed', () => {
    const id = seed({ state: 'rate_limited', cooldownUntil: '2026-10-13T12:01:00.000Z' });
    const pool = makePool();

    // Before the clock: still resting.
    pool.sweep();
    expect(accounts.findById(id)?.state).toBe('rate_limited');

    clock = new Date('2026-10-13T12:01:00.000Z');
    pool.sweep();
    expect(accounts.findById(id)?.state).toBe('active');
  });

  it('brings an exhausted account back once its quota window has reset', () => {
    const id = seed({ state: 'exhausted', quotaResetAt: '2026-10-13T12:30:00.000Z' });
    const pool = makePool();

    pool.sweep();
    expect(accounts.findById(id)?.state).toBe('exhausted');

    clock = new Date('2026-10-13T12:30:00.000Z');
    pool.sweep();
    expect(accounts.findById(id)?.state).toBe('active');
  });

  it('leaves an exhausted account with no reset time alone', () => {
    const id = seed({ state: 'exhausted', quotaResetAt: null });
    const pool = makePool();

    clock = new Date('2026-11-01T00:00:00.000Z');
    pool.sweep();

    // The window belongs to the provider; the sweep has no clock to read for it.
    expect(accounts.findById(id)?.state).toBe('exhausted');
  });

  it('never brings back an account an operator disabled', () => {
    const id = seed({ state: 'disabled', cooldownUntil: '2026-10-13T11:00:00.000Z' });
    const pool = makePool();

    pool.sweep();
    expect(accounts.findById(id)?.state).toBe('disabled');
  });

  it('does not disturb an active account', () => {
    const id = seed({ state: 'active' });
    makePool().sweep();
    expect(accounts.findById(id)?.state).toBe('active');
  });
});

describe('a model that spends an allowance', () => {
  /**
   * qoder's free plan has no credits: `lite` is priced at zero and answers, every
   * other model accepts the request and sends nothing at all. Sending the turn
   * anyway costs a round trip and reports a hang; refusing the pairing says why
   * in the same breath.
   *
   * The flag is the manifest's, and the balance is the provider's — a `0 / 0`
   * answer leaves it null, so only an account the provider *said* is spent is
   * refused.
   */

  function seedWithBalance(balance: number | null): string {
    const id = seed({ providerId: 'qoder' });
    accounts.setQuota(
      id,
      {
        windowSeconds: null,
        limit: null,
        remaining: null,
        resetAt: null,
        creditBalance: balance,
        creditCurrency: null,
      },
      START.toISOString(),
    );
    return id;
  }

  it('refuses a metered model on an account the provider says is spent', () => {
    seedWithBalance(0);
    const pool = makePool();

    const outcome = pool.acquire('qoder', { requiresCredit: true });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.reason).toBe('no-credit');
  });

  it('still serves a model that costs nothing from the same account', () => {
    // `lite` is the whole reason a zero balance is not a parked account: the
    // account can serve, just not the metered models.
    seedWithBalance(0);
    const pool = makePool();

    expect(pool.acquire('qoder').ok).toBe(true);
  });

  it('serves a metered model from an account whose balance is unreported', () => {
    // `0 / 0` from a provider means it does not meter this plan, not that the
    // account is empty — so a null balance is not a refusal.
    seedWithBalance(null);
    const pool = makePool();

    expect(pool.acquire('qoder', { requiresCredit: true }).ok).toBe(true);
  });

  it('says busy, not no-credit, when the account is merely cooling', () => {
    const id = seed({ providerId: 'qoder', state: 'rate_limited', cooldownUntil: '2026-10-13T12:05:00.000Z' });
    accounts.setQuota(
      id,
      {
        windowSeconds: null,
        limit: null,
        remaining: null,
        resetAt: null,
        creditBalance: 5,
        creditCurrency: null,
      },
      START.toISOString(),
    );

    const outcome = makePool().acquire('qoder', { requiresCredit: true });

    expect(outcome.ok ? null : outcome.reason).toBe('busy');
  });
});
