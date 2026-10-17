import { describe, expect, it } from 'vitest';
import { createProviderRegistry } from '@registry';
import { providerManifests } from '@registry/providers/index.ts';

import { upstreamFailure } from '@server/providers/dispatch-errors.ts';
import { outcomeFromError } from '@server/pool/outcome.ts';

/**
 * What a provider's refusal means, and who has to hear it (C4.6).
 *
 * The manifest's `errors` table is the authority: kiro declares 401 and 403 as
 * `auth`, which is its own statement that those statuses are about the credential
 * rather than about the request. Two consumers read that answer and they need
 * different things from it — the client gets a 502 saying the provider could not
 * serve the turn, and the pool gets enough to park the account.
 *
 * These tests exist because the two disagreed. The probe banned a suspended kiro
 * account on its 403 while a turn retried it on every request, so twelve suspended
 * accounts stayed in rotation and a turn landed on the one working account about
 * one time in thirteen.
 */

const kiro = createProviderRegistry(providerManifests).get('kiro');
if (kiro === undefined) throw new Error('the catalogue has no kiro manifest');

describe('a refusal the manifest calls auth', () => {
  it('is a 502 to the client, because their key is not the problem', () => {
    const error = upstreamFailure(kiro, 403, '{"reason":"TEMPORARILY_SUSPENDED"}', null);

    expect(error.kind).toBe('upstream_error');
    expect(error.status).toBe(502);
    expect(error.provider).toBe('kiro');
  });

  it('tells the pool the account is what was refused', () => {
    const error = upstreamFailure(kiro, 403, '{"reason":"TEMPORARILY_SUSPENDED"}', null);

    expect(error.credentialRefused).toBe(true);
    expect(outcomeFromError(error, new Date('2026-10-17T00:00:00.000Z')).state).toBe('banned');
  });

  it('does not confuse a rate limit with a refusal', () => {
    // Same status, different class: kiro's table lists 429 as `rate_limit`, and
    // parking an account for a window that reopens would be wrong.
    const error = upstreamFailure(kiro, 429, '', 30);
    expect(error.credentialRefused).toBe(false);
    expect(error.kind).toBe('rate_limit');
  });
});
