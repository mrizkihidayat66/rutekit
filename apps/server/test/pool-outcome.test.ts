import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '@server/errors.ts';
import { silentLogger } from '@server/observability/logger.ts';
import { openPersistence, type Persistence } from '@server/persistence/client.ts';
import { runMigrations } from '@server/persistence/migrate.ts';
import {
  createProviderAccountsRepository,
  type ProviderAccountsRepository,
} from '@server/persistence/provider-accounts.ts';
import {
  FAILURE_THRESHOLD,
  createOutcomeWriter,
  outcomeFromError,
  outcomeFromStatus,
} from '@server/pool/outcome.ts';

/**
 * What an upstream answer means for the account it came from (FR-3.1, FR-3.3).
 *
 * Two halves. The mapping is pure and asserted directly; the writer is asserted
 * against a real SQLite row, because what it does is a write and the interesting
 * behaviour — a streak that escalates at the threshold, a move the table refuses
 * — only exists in the database.
 *
 * The policy under test throughout is the one `outcome.ts` states: the account is
 * only ever blamed for what the account can be blamed for.
 */

const AT = new Date('2026-10-13T12:00:00.000Z');

describe('outcomeFromError', () => {
  it('ignores a failure that says nothing about the credential', () => {
    for (const error of [
      AppError.invalidRequest('bad body'),
      AppError.notFound('no such model'),
      AppError.unavailable('not wired yet'),
      AppError.shuttingDown(),
      new AppError('aborted'),
    ]) {
      expect(outcomeFromError(error, AT).effect, error.kind).toBe('ignore');
    }
  });

  it('rests an account the provider rate-limited, honouring its retry-after', () => {
    const outcome = outcomeFromError(AppError.rateLimit(30), AT);
    expect(outcome.effect).toBe('rest');
    expect(outcome.state).toBe('rate_limited');
    expect(outcome.cooldownUntil).toBe('2026-10-13T12:00:30.000Z');
  });

  it('rests a rate-limited account on the default when no retry-after came', () => {
    const outcome = outcomeFromError(AppError.rateLimit(null), AT);
    expect(outcome.state).toBe('rate_limited');
    expect(outcome.cooldownUntil).toBe('2026-10-13T12:01:00.000Z');
  });

  it('exhausts an account with no cooldown of our own', () => {
    const outcome = outcomeFromError(new AppError('quota_exhausted'), AT);
    expect(outcome.effect).toBe('rest');
    expect(outcome.state).toBe('exhausted');
    // The window belongs to the provider; only a check-in notices it reopening.
    expect(outcome.cooldownUntil).toBeNull();
  });

  it('bans an account the provider refused', () => {
    expect(outcomeFromError(AppError.authentication(), AT).state).toBe('banned');
    expect(outcomeFromError(AppError.permission('no'), AT).state).toBe('banned');
  });

  it('treats a timeout, a 5xx or a bug as transient', () => {
    expect(outcomeFromError(AppError.timeout(), AT).effect).toBe('transient');
    expect(outcomeFromError(AppError.upstreamError('boom'), AT).effect).toBe('transient');
    expect(outcomeFromError(AppError.internal(), AT).effect).toBe('transient');
  });

  it('treats a bare throw as transient, because nothing classified it', () => {
    expect(outcomeFromError(new Error('socket hang up'), AT).effect).toBe('transient');
    expect(outcomeFromError('not even an error', AT).effect).toBe('transient');
  });
});

describe('outcomeFromStatus', () => {
  it('bans on a refusal aimed at the credential', () => {
    expect(outcomeFromStatus(401, null, AT).state).toBe('banned');
    expect(outcomeFromStatus(403, null, AT).state).toBe('banned');
  });

  it('exhausts on 402', () => {
    expect(outcomeFromStatus(402, null, AT).state).toBe('exhausted');
  });

  it('rests on 429, honouring the retry-after it was given', () => {
    const outcome = outcomeFromStatus(429, 5, AT);
    expect(outcome.state).toBe('rate_limited');
    expect(outcome.cooldownUntil).toBe('2026-10-13T12:00:05.000Z');
  });

  it('treats a 5xx as transient', () => {
    expect(outcomeFromStatus(500, null, AT).effect).toBe('transient');
    expect(outcomeFromStatus(503, null, AT).effect).toBe('transient');
  });

  it('reads any other answer as proof the credential lives', () => {
    // A 400 or a 404 means auth passed and the request was the problem, so the
    // account recovers — which is what lets an `error` account come back.
    for (const status of [200, 400, 404, 422]) {
      expect(outcomeFromStatus(status, null, AT).effect, String(status)).toBe('recover');
    }
  });
});

let persistence: Persistence;
let accounts: ProviderAccountsRepository;

beforeEach(() => {
  persistence = openPersistence({
    databaseUrl: ':memory:',
    dataDir: mkdtempSync(join(tmpdir(), 'rutekit-outcome-')),
  });
  runMigrations(persistence.sqlite);
  accounts = createProviderAccountsRepository(persistence.db);
});

afterEach(() => {
  persistence.close();
});

function seed(state: string, consecutiveFailures = 0): string {
  const at = AT.toISOString();
  const id = crypto.randomUUID();
  accounts.create({
    id,
    providerId: 'openai',
    label: 'openai test',
    credentialEnvelope: 'v1:iv:tag:ciphertext',
    authMode: 'api-key',
    state,
    consecutiveFailures,
    createdAt: at,
    updatedAt: at,
  });
  return id;
}

function writer(): ReturnType<typeof createOutcomeWriter> {
  return createOutcomeWriter({ accounts, logger: silentLogger(), now: () => AT });
}

describe('createOutcomeWriter', () => {
  it('does nothing for an ignored outcome', () => {
    const id = seed('active');

    writer().apply(id, { effect: 'ignore', reason: '', state: null, cooldownUntil: null });

    const row = accounts.findById(id);
    expect(row?.state).toBe('active');
    expect(row?.consecutiveFailures).toBe(0);
  });

  it('advances the streak without parking before the threshold', () => {
    const id = seed('active');
    const w = writer();

    for (let i = 0; i < FAILURE_THRESHOLD - 1; i += 1) {
      w.apply(id, { effect: 'transient', reason: '', state: null, cooldownUntil: null });
    }

    const row = accounts.findById(id);
    expect(row?.state).toBe('active');
    expect(row?.consecutiveFailures).toBe(FAILURE_THRESHOLD - 1);
  });

  it('parks an account once the streak reaches the threshold', () => {
    const id = seed('active', FAILURE_THRESHOLD - 1);

    writer().apply(id, { effect: 'transient', reason: '', state: null, cooldownUntil: null });

    const row = accounts.findById(id);
    expect(row?.state).toBe('error');
    expect(row?.stateReason).toContain(String(FAILURE_THRESHOLD));
  });

  it('recovers an error account and clears the streak behind it', () => {
    const id = seed('error', FAILURE_THRESHOLD);

    writer().apply(id, { effect: 'recover', reason: '', state: 'active', cooldownUntil: null });

    const row = accounts.findById(id);
    expect(row?.state).toBe('active');
    // Clearing the streak is the point: one bad hour must not leave the next
    // single failure sitting on the edge of the threshold.
    expect(row?.consecutiveFailures).toBe(0);
  });

  it('parks an account the provider refused, in banned', () => {
    const id = seed('active');

    writer().apply(id, {
      effect: 'ban',
      reason: 'The provider rejected this credential.',
      state: 'banned',
      cooldownUntil: null,
    });

    expect(accounts.findById(id)?.state).toBe('banned');
  });

  it('rests an account with the cooldown it was given', () => {
    const id = seed('active');
    const until = '2026-10-13T12:05:00.000Z';

    writer().apply(id, {
      effect: 'rest',
      reason: 'Rate limited by the provider.',
      state: 'rate_limited',
      cooldownUntil: until,
    });

    const row = accounts.findById(id);
    expect(row?.state).toBe('rate_limited');
    expect(row?.cooldownUntil).toBe(until);
  });

  it('never moves an account an operator disabled', () => {
    const id = seed('disabled', FAILURE_THRESHOLD);
    const w = writer();

    // A probe that succeeded, a quota that reset, a streak that ran on: none of
    // them may bring a disabled account back. Only an operator can.
    w.apply(id, { effect: 'recover', reason: '', state: 'active', cooldownUntil: null });
    w.apply(id, { effect: 'transient', reason: '', state: null, cooldownUntil: null });
    w.apply(id, {
      effect: 'rest',
      reason: 'Rate limited.',
      state: 'rate_limited',
      cooldownUntil: AT.toISOString(),
    });

    expect(accounts.findById(id)?.state).toBe('disabled');
  });

  it('ignores an outcome for an account that is no longer there', () => {
    const w = writer();
    expect(() =>
      w.apply('missing', { effect: 'recover', reason: '', state: 'active', cooldownUntil: null }),
    ).not.toThrow();
  });
});
