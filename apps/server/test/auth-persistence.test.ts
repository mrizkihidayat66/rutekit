import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Persistence } from '@server/persistence/client.ts';
import { openPersistence } from '@server/persistence/client.ts';
import { runMigrations } from '@server/persistence/migrate.ts';
import { createApiKeysRepository } from '@server/persistence/api-keys.ts';
import type { ApiKeysRepository } from '@server/persistence/api-keys.ts';
import { createAuthCredentialRepository } from '@server/persistence/auth-credential.ts';
import type { AuthCredentialRepository } from '@server/persistence/auth-credential.ts';
import { createSessionsRepository } from '@server/persistence/sessions.ts';
import type { SessionsRepository } from '@server/persistence/sessions.ts';

/**
 * The C2 repositories, against a real SQLite database.
 *
 * A mock would prove nothing here: what is under test is exactly the parts a
 * mock replaces — the JSON column round-trip, the unique constraint on the token
 * hash, and the `count(*)` behind a page. The schema itself comes from the
 * shipped migrations, so a migration that disagrees with the Drizzle table
 * definition fails here rather than at boot.
 */

const AT = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-02T00:00:00.000Z';

interface Fixture {
  persistence: Persistence;
  credentials: AuthCredentialRepository;
  sessions: SessionsRepository;
  apiKeys: ApiKeysRepository;
}

function fresh(): Fixture {
  const persistence = openPersistence({
    databaseUrl: ':memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'rutekit-auth-')),
  });
  runMigrations(persistence.sqlite);
  return {
    persistence,
    credentials: createAuthCredentialRepository(persistence.db),
    sessions: createSessionsRepository(persistence.db),
    apiKeys: createApiKeysRepository(persistence.db),
  };
}

function credential(id = 'operator') {
  return {
    id,
    passwordHash: '$argon2id$stub',
    instanceName: 'rutekit',
    createdAt: AT,
    updatedAt: AT,
  };
}

describe('auth-credential repository', () => {
  let f: Fixture;
  beforeEach(() => {
    f = fresh();
  });

  it('is empty before setup and holds one row after', () => {
    expect(f.credentials.get()).toBeNull();

    f.credentials.create(credential());

    expect(f.credentials.get()?.passwordHash).toBe('$argon2id$stub');
    expect(f.credentials.get()?.instanceName).toBe('rutekit');
  });

  it('refuses a second credential', () => {
    f.credentials.create(credential());

    expect(() => f.credentials.create(credential('someone-else'))).toThrow(/already exists/);
    expect(f.credentials.get()?.id).toBe('operator');
  });

  it('replaces the password hash in place', () => {
    f.credentials.create(credential());

    f.credentials.updatePasswordHash('operator', '$argon2id$new', LATER);

    expect(f.credentials.get()?.passwordHash).toBe('$argon2id$new');
    expect(f.credentials.get()?.updatedAt).toBe(LATER);
    expect(f.credentials.get()?.createdAt).toBe(AT);
  });

  it('renames the instance without touching the password', () => {
    f.credentials.create(credential());

    f.credentials.updateInstanceName('operator', 'gateway', LATER);

    expect(f.credentials.get()?.instanceName).toBe('gateway');
    expect(f.credentials.get()?.passwordHash).toBe('$argon2id$stub');
  });
});

describe('sessions repository', () => {
  let f: Fixture;
  beforeEach(() => {
    f = fresh();
  });

  const session = (id: string, tokenHash: string, expiresAt: string) => ({
    id,
    tokenHash,
    createdAt: AT,
    expiresAt,
  });

  it('looks a session up by the hash of its token', () => {
    f.sessions.create(session('s1', 'hash-one', LATER));

    expect(f.sessions.findByTokenHash('hash-one')?.id).toBe('s1');
    expect(f.sessions.findByTokenHash('hash-absent')).toBeNull();
  });

  it('rejects a token hash that is already in use', () => {
    f.sessions.create(session('s1', 'hash-one', LATER));

    expect(() => f.sessions.create(session('s2', 'hash-one', LATER))).toThrow();
  });

  it('slides the expiry forward', () => {
    f.sessions.create(session('s1', 'hash-one', AT));

    f.sessions.touch('s1', LATER);

    expect(f.sessions.findByTokenHash('hash-one')?.expiresAt).toBe(LATER);
  });

  it('deletes a single session on logout', () => {
    f.sessions.create(session('s1', 'hash-one', LATER));

    f.sessions.delete('s1');

    expect(f.sessions.findByTokenHash('hash-one')).toBeNull();
  });

  it('sweeps only the expired rows and reports how many went', () => {
    f.sessions.create(session('expired', 'hash-old', '2025-12-31T00:00:00.000Z'));
    f.sessions.create(session('live', 'hash-live', LATER));

    const removed = f.sessions.deleteExpired(AT);

    expect(removed).toBe(1);
    expect(f.sessions.findByTokenHash('hash-old')).toBeNull();
    expect(f.sessions.findByTokenHash('hash-live')?.id).toBe('live');
  });
});

describe('api-keys repository', () => {
  let f: Fixture;
  beforeEach(() => {
    f = fresh();
  });

  function key(id: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      name: `key ${id}`,
      prefix: `rk-${id}`,
      secretHash: `hash-${id}`,
      createdAt: AT,
      ...overrides,
    };
  }

  it('fills the JSON and counter columns with their defaults', () => {
    f.apiKeys.create(key('a'));

    const row = f.apiKeys.findById('a');
    expect(row?.modelsAllowed).toEqual([]);
    expect(row?.modelsDenied).toEqual([]);
    expect(row?.clientRouterDenylist).toEqual([]);
    expect(row?.usageRequests).toBe(0);
    expect(row?.usageInputTokens).toBe(0);
    expect(row?.usageOutputTokens).toBe(0);
    expect(row?.revokedAt).toBeNull();
    expect(row?.lastUsedAt).toBeNull();
    expect(row?.budgetRequests).toBeNull();
  });

  it('round-trips the model lists through the JSON column', () => {
    f.apiKeys.create(key('a', { modelsAllowed: ['gpt-4o', 'claude-sonnet'], modelsDenied: ['x'] }));

    const row = f.apiKeys.findById('a');
    expect(row?.modelsAllowed).toEqual(['gpt-4o', 'claude-sonnet']);
    expect(row?.modelsDenied).toEqual(['x']);
  });

  it('finds a key by the hash of its secret', () => {
    f.apiKeys.create(key('a'));

    expect(f.apiKeys.findBySecretHash('hash-a')?.id).toBe('a');
    expect(f.apiKeys.findBySecretHash('hash-nope')).toBeNull();
  });

  it('lists every row and counts the whole table', () => {
    f.apiKeys.create(key('old', { createdAt: AT }));
    f.apiKeys.create(key('mid', { createdAt: '2026-01-01T12:00:00.000Z' }));
    f.apiKeys.create(key('new', { createdAt: LATER }));

    expect(f.apiKeys.count()).toBe(3);
    expect(f.apiKeys.listAll().map((r) => r.id).sort()).toEqual(['mid', 'new', 'old']);
  });

  it('leaves absent fields alone and clears explicit nulls', () => {
    f.apiKeys.create(key('a', { name: 'before', budgetRequests: 100 }));

    f.apiKeys.update('a', {});
    expect(f.apiKeys.findById('a')?.name).toBe('before');
    expect(f.apiKeys.findById('a')?.budgetRequests).toBe(100);

    f.apiKeys.update('a', { budgetRequests: null, tpsLimit: 5 });
    expect(f.apiKeys.findById('a')?.budgetRequests).toBeNull();
    expect(f.apiKeys.findById('a')?.tpsLimit).toBe(5);
    expect(f.apiKeys.findById('a')?.name).toBe('before');
  });

  it('stamps revocation without removing the row', () => {
    f.apiKeys.create(key('a'));

    f.apiKeys.revoke('a', LATER);

    expect(f.apiKeys.findById('a')?.revokedAt).toBe(LATER);
    expect(f.apiKeys.count()).toBe(1);
  });

  it('accumulates usage across calls instead of overwriting it', () => {
    f.apiKeys.create(key('a'));

    f.apiKeys.recordUsage('a', { requests: 1, inputTokens: 10, outputTokens: 5 }, AT);
    f.apiKeys.recordUsage('a', { requests: 2, inputTokens: 20, outputTokens: 7 }, LATER);

    const row = f.apiKeys.findById('a');
    expect(row?.usageRequests).toBe(3);
    expect(row?.usageInputTokens).toBe(30);
    expect(row?.usageOutputTokens).toBe(12);
    expect(row?.lastUsedAt).toBe(LATER);
  });

  it('deletes a key outright', () => {
    f.apiKeys.create(key('a'));

    f.apiKeys.delete('a');

    expect(f.apiKeys.findById('a')).toBeNull();
    expect(f.apiKeys.count()).toBe(0);
  });
});
