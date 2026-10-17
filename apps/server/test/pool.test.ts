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
import { createPool, type Pool } from '@server/pool/pool.ts';
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

describe('createPool.acquire', () => {
  it('answers null when the provider has no accounts', () => {
    expect(makePool().acquire('openai')).toBeNull();
  });

  it('answers null when no account is in a routable state', () => {
    seed({ state: 'pending' });
    seed({ state: 'disabled' });
    seed({ state: 'rate_limited' });

    expect(makePool().acquire('openai')).toBeNull();
  });

  it('hands back a credential for an active account', () => {
    const id = seed({ credential: 'sk-live' });

    const lease = makePool().acquire('openai');
    expect(lease?.accountId).toBe(id);
    expect(lease?.credential.value).toBe('sk-live');
  });

  it('counts the lease while it is held', () => {
    seed();
    const pool = makePool();

    const lease = pool.acquire('openai');
    expect(lease).not.toBeNull();
    expect(pool.inFlight(lease?.accountId ?? '')).toBe(1);
  });

  it('refuses a second turn once an account is at its ceiling', () => {
    seed({ maxInFlight: 1 });
    const pool = makePool();

    expect(pool.acquire('openai')).not.toBeNull();
    // Nothing left to take: the one account is full and there is no sibling.
    expect(pool.acquire('openai')).toBeNull();
  });

  it('spreads turns across siblings up to each one’s ceiling', () => {
    seed({ id: 'a', maxInFlight: 1 });
    seed({ id: 'b', maxInFlight: 1 });
    const pool = makePool('round_robin');

    const first = pool.acquire('openai');
    const second = pool.acquire('openai');
    expect([first?.accountId, second?.accountId]).toEqual(['a', 'b']);
    expect(pool.acquire('openai')).toBeNull();
  });

  it('skips an account whose credential will not decrypt', () => {
    const id = seed();
    // A second box with a different key: the row's envelope is unreadable to it.
    const pool = makePool('round_robin', new SecretBox('cd'.repeat(32)));

    expect(pool.acquire('openai')).toBeNull();
    expect(pool.inFlight(id)).toBe(0);
  });

  it('answers null when no key is configured at all', () => {
    seed();
    expect(makePool('round_robin', null).acquire('openai')).toBeNull();
  });

  it('only ever considers the provider asked for', () => {
    seed({ id: 'openai-1', providerId: 'openai' });
    seed({ id: 'anthropic-1', providerId: 'anthropic' });
    const pool = makePool();

    expect(pool.acquire('anthropic')?.accountId).toBe('anthropic-1');
  });

  it('rotates through the siblings across turns', () => {
    seed({ id: 'a', maxInFlight: 5 });
    seed({ id: 'b', maxInFlight: 5 });
    const pool = makePool('round_robin');

    const taken = [pool.acquire('openai'), pool.acquire('openai'), pool.acquire('openai')].map(
      (lease) => lease?.accountId,
    );
    expect(taken).toEqual(['a', 'b', 'a']);
  });

  it('honours the sequential strategy’s stated order', () => {
    seed({ id: 'a', maxInFlight: 5 });
    seed({ id: 'b', maxInFlight: 5 });
    const pool = makePool('sequential');

    expect(pool.acquire('openai')?.accountId).toBe('a');
    expect(pool.acquire('openai')?.accountId).toBe('a');
  });
});

describe('settling a lease', () => {
  it('releases the in-flight count on success and stamps the use', () => {
    const id = seed();
    const pool = makePool();

    const lease = pool.acquire('openai');
    lease?.succeed();

    expect(pool.inFlight(id)).toBe(0);
    expect(accounts.findById(id)?.lastUsedAt).toBe(clock.toISOString());
  });

  it('releases the in-flight count on failure', () => {
    const id = seed();
    const pool = makePool();

    pool.acquire('openai')?.fail(AppError.upstreamError('boom'));

    expect(pool.inFlight(id)).toBe(0);
  });

  it('parks an account the provider rate-limited, with the cooldown it named', () => {
    const id = seed();
    const pool = makePool();

    pool.acquire('openai')?.fail(AppError.rateLimit(45));

    const row = accounts.findById(id);
    expect(row?.state).toBe('rate_limited');
    expect(row?.cooldownUntil).toBe('2026-10-13T12:00:45.000Z');
  });

  it('settles only once, so a stream that dies cannot leak capacity', () => {
    const id = seed();
    const pool = makePool();

    const lease = pool.acquire('openai');
    lease?.succeed();
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

    pool.acquire('openai')?.succeed();
    expect(pool.acquire('openai')).not.toBeNull();
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
