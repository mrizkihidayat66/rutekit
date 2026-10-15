import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openPersistence, type Persistence } from '@server/persistence/client.ts';
import { runMigrations } from '@server/persistence/migrate.ts';
import {
  createProviderAccountsRepository,
  type ProviderAccountsRepository,
} from '@server/persistence/provider-accounts.ts';

/**
 * The account store (C3b2).
 *
 * A real SQLite file rather than a mock, for the same reason `persistence.test.ts`
 * uses one: the interesting behaviour is the driver's — a default that only the
 * schema knows, and an `update` that must leave every other column alone.
 */

let persistence: Persistence;
let accounts: ProviderAccountsRepository;

beforeEach(() => {
  persistence = openPersistence({
    databaseUrl: ':memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'rutekit-accounts-')),
  });
  runMigrations(persistence.sqlite);
  accounts = createProviderAccountsRepository(persistence.db);
});

afterEach(() => {
  persistence.close();
});

const seed = (overrides: Partial<Parameters<ProviderAccountsRepository['create']>[0]> = {}) => {
  accounts.create({
    id: 'acct-1',
    providerId: 'kiro',
    label: 'Kiro (work)',
    credentialEnvelope: 'v1:iv:tag:ciphertext',
    authMode: 'oauth-device',
    emailMasked: 'o•••@example.com',
    createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  });
};

describe('createProviderAccountsRepository', () => {
  it('round-trips a row, with the state machine columns defaulted', () => {
    seed();

    const row = accounts.findById('acct-1');
    expect(row).not.toBeNull();
    expect(row?.providerId).toBe('kiro');
    expect(row?.credentialEnvelope).toBe('v1:iv:tag:ciphertext');
    expect(row?.state).toBe('active');
    expect(row?.stateReason).toBeNull();
    expect(row?.maxInFlight).toBe(1);
    expect(row?.note).toBeNull();
  });

  it('lists only the accounts of the provider asked for', () => {
    seed();
    seed({ id: 'acct-2', providerId: 'qoder', emailMasked: 'q•••@example.com' });

    expect(accounts.listByProvider('kiro').map((row) => row.id)).toEqual(['acct-1']);
    expect(accounts.listByProvider('qoder').map((row) => row.id)).toEqual(['acct-2']);
    expect(accounts.listByProvider('codebuddy-intl')).toEqual([]);
  });

  it('finds the row a re-sign-in should replace, by provider and masked email', () => {
    seed();
    seed({ id: 'acct-2', providerId: 'qoder', emailMasked: 'o•••@example.com' });

    expect(accounts.findByProviderAndEmail('kiro', 'o•••@example.com')?.id).toBe('acct-1');
    // Same email, different provider: a different account, not the same one.
    expect(accounts.findByProviderAndEmail('qoder', 'o•••@example.com')?.id).toBe('acct-2');
    expect(accounts.findByProviderAndEmail('kiro', 'nobody@example.com')).toBeNull();
  });

  it('replaces the credential without disturbing the lifecycle state', () => {
    seed({ state: 'error', stateReason: 'token revoked' });

    accounts.setCredential('acct-1', 'v1:iv2:tag2:ciphertext2', '2026-10-13T01:00:00.000Z');

    const row = accounts.findById('acct-1');
    expect(row?.credentialEnvelope).toBe('v1:iv2:tag2:ciphertext2');
    expect(row?.updatedAt).toBe('2026-10-13T01:00:00.000Z');
    // A fresh credential is not evidence that the account may route again: a
    // `disabled` account is manual-only, so the sign-in must not revive it.
    expect(row?.state).toBe('error');
    expect(row?.stateReason).toBe('token revoked');
  });

  it('deletes a row for good', () => {
    seed();
    accounts.delete('acct-1');

    expect(accounts.findById('acct-1')).toBeNull();
    expect(accounts.listByProvider('kiro')).toEqual([]);
  });
});
