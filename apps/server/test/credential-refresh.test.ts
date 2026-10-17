import { describe, expect, it } from 'vitest';
import { createIdFactory } from '@shared';
import type { CodecContext } from '@translator';

import { nodeCrypto } from '@server/providers/codec-crypto.ts';
import {
  needsRenewal,
  refreshCredential,
  type RefreshPolicy,
} from '@server/providers/credential-refresh.ts';

/**
 * Renewing an access token before it is spent (C4.6).
 *
 * **This exists because rutekit never did it.** A provider issues a refresh token
 * beside its access token and expects the client to spend it; rutekit read the
 * field and left it unused, so an account imported in the morning was dead by the
 * afternoon and the only way back was another browser sign-in. For a provider
 * whose accounts come from automation, that is the most expensive possible way to
 * handle a clock.
 *
 * The mechanism is provider-neutral: the manifest says where to ask and what to
 * send, and this is what spends it. The tests are about the decisions that are
 * easy to get wrong — which failures are worth retrying, and what happens to a
 * rotated refresh token.
 */

const POLICY: RefreshPolicy = {
  kind: 'template',
  url: 'https://example.test/refreshToken',
  bodyTemplate: '{"refreshToken":{refreshToken}}',
  accessTokenField: 'accessToken',
  refreshTokenField: 'refreshToken',
};

function stub(answer: () => Response | Promise<Response>): {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  calls: { url: string; body: string | undefined }[];
} {
  const calls: { url: string; body: string | undefined }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, body: typeof init.body === 'string' ? init.body : undefined });
      return await answer();
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const FIELDS = { accessToken: 'old-token', refreshToken: 'refresh-1', profileArn: 'arn:x' };

const CONTEXT: CodecContext = {
  now: () => 1_700_000_000,
  ids: createIdFactory((bytes) => new Uint8Array(bytes)),
  model: 'test-model',
  account: FIELDS,
  crypto: nodeCrypto,
};

describe('renewing a credential', () => {
  it('spends the refresh token and returns the new access token', async () => {
    const { fetch, calls } = stub(() => json({ accessToken: 'new-token' }));

    const outcome = await refreshCredential(POLICY, FIELDS, CONTEXT, fetch, 5_000);

    expect(outcome.ok).toBe(true);
    expect(outcome.ok ? outcome.fields['accessToken'] : null).toBe('new-token');
    // The token travels in the body, substituted into the manifest's template —
    // every provider spells that request differently and none needs code.
    expect(calls[0]?.body).toBe('{"refreshToken":"refresh-1"}');
  });

  it('keeps a rotated refresh token, because the old one is spent', async () => {
    // A provider that rotates retires the old token on every renewal. Returning
    // only the access token would make the *next* renewal fail with a token the
    // provider has already retired — the failure this whole module prevents.
    const { fetch } = stub(() => json({ accessToken: 'new-token', refreshToken: 'refresh-2' }));

    const outcome = await refreshCredential(POLICY, FIELDS, CONTEXT, fetch, 5_000);

    expect(outcome.ok ? outcome.fields['refreshToken'] : null).toBe('refresh-2');
  });

  it('leaves the refresh token alone when the provider does not rotate', async () => {
    const { fetch } = stub(() => json({ accessToken: 'new-token' }));
    const outcome = await refreshCredential(POLICY, FIELDS, CONTEXT, fetch, 5_000);
    expect(outcome.ok ? 'refreshToken' in outcome.fields : true).toBe(false);
  });

  it('records a new expiry when the answer carries one', async () => {
    const { fetch } = stub(() => json({ accessToken: 'n', expiresAt: '2026-01-01T00:00:00.000Z' }));
    const outcome = await refreshCredential(POLICY, FIELDS, CONTEXT, fetch, 5_000);
    expect(outcome.ok ? outcome.fields['expiresAt'] : null).toBe('2026-01-01T00:00:00.000Z');
  });

  it('refuses an account with no refresh token, and says why', async () => {
    const { fetch, calls } = stub(() => json({ accessToken: 'n' }));
    const outcome = await refreshCredential(POLICY, { accessToken: 'only' }, CONTEXT, fetch, 5_000);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.reason).toContain('no refresh token');
    // Not even attempted: there is nothing to send.
    expect(calls).toHaveLength(0);
  });
});

describe('what a failure means', () => {
  it('retries a server error, which says nothing about the credential', async () => {
    const { fetch } = stub(() => new Response(null, { status: 503 }));
    const outcome = await refreshCredential(POLICY, FIELDS, CONTEXT, fetch, 5_000);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? true : outcome.retryable).toBe(true);
  });

  it('does not retry a refusal, which means the account needs a sign-in', async () => {
    // A 4xx is the refresh token being dead. Another attempt spends the same dead
    // token, and the message names the thing an operator actually has to do.
    const { fetch } = stub(() => new Response(null, { status: 400 }));
    const outcome = await refreshCredential(POLICY, FIELDS, CONTEXT, fetch, 5_000);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? true : outcome.retryable).toBe(false);
    expect(outcome.ok ? '' : outcome.reason).toContain('new sign-in');
  });

  it('retries a transport failure', async () => {
    const { fetch } = stub(() => {
      throw new Error('socket closed');
    });
    const outcome = await refreshCredential(POLICY, FIELDS, CONTEXT, fetch, 5_000);
    expect(outcome.ok ? false : outcome.retryable).toBe(true);
  });

  it('refuses an answer without an access token', async () => {
    const { fetch } = stub(() => json({ refreshToken: 'refresh-2' }));
    const outcome = await refreshCredential(POLICY, FIELDS, CONTEXT, fetch, 5_000);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.reason).toContain('without an access token');
  });
});

describe('a renewal the wire signs itself', () => {
  /**
   * qoder's renewal is not a URL and a template: the request carries a session
   * key encrypted to the provider's public key and an MD5 over the headers, so
   * the codec builds it and reads the answer. The manifest says only that a
   * renewal exists — a provider without one must not be probed as though it had
   * one.
   */

  const WIRE: RefreshPolicy = {
    kind: 'wire',
    url: 'https://example.test/jobToken',
    renew: () => ({
      url: 'https://example.test/jobToken?Encode=1',
      headers: { appcode: 'cosy', signature: 'sig' },
      body: 'encoded-body',
      read: (answer) => {
        const record = (answer ?? {}) as Record<string, unknown>;
        const token = record['securityOauthToken'];
        if (typeof token !== 'string' || token === '') return null;
        return { securityOauthToken: token };
      },
    }),
  };

  it('sends the request the wire built, not one this module invented', async () => {
    const { fetch, calls } = stub(() => json({ securityOauthToken: 'session-2' }));

    const outcome = await refreshCredential(WIRE, FIELDS, CONTEXT, fetch, 5_000);

    expect(outcome.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://example.test/jobToken?Encode=1');
    expect(calls[0]?.body).toBe('encoded-body');
  });

  it('reads the answer through the wire, so a provider names its own fields', async () => {
    // qoder calls its token `securityOauthToken`, not `accessToken`. The template
    // path could not know that without the manifest naming it; here the codec does.
    const { fetch } = stub(() => json({ securityOauthToken: 'session-2', refreshToken: 'r-2' }));

    const outcome = await refreshCredential(WIRE, FIELDS, CONTEXT, fetch, 5_000);

    expect(outcome.ok ? outcome.fields : null).toEqual({ securityOauthToken: 'session-2' });
  });

  it('refuses an answer the wire could not read', async () => {
    const { fetch } = stub(() => json({ message: 'no token here' }));
    const outcome = await refreshCredential(WIRE, FIELDS, CONTEXT, fetch, 5_000);
    expect(outcome.ok).toBe(false);
  });
});

describe('whether a renewal is worth making', () => {
  /**
   * A refresh is a round trip and, for a rotating provider, a write. Renewing
   * before every request because the token might be old is a cost with nothing
   * bought — so the recorded expiry decides, and only a credential with no
   * recorded expiry is renewed unconditionally.
   */

  it('renews a token that has expired', () => {
    expect(needsRenewal('2023-11-14T21:00:00.000Z', 1_700_000_000)).toBe(true);
  });

  it('renews a token that would expire mid-turn', () => {
    // The clock is the server's, and a token that dies during the request is as
    // useless as one that already has — so a minute of slack, not zero.
    expect(needsRenewal('2023-11-14T22:14:00.000Z', 1_700_000_000)).toBe(true);
  });

  it('leaves a token with life left alone', () => {
    expect(needsRenewal('2023-11-14T23:00:00.000Z', 1_700_000_000)).toBe(false);
  });

  it('renews when there is no recorded expiry, because it cannot tell', () => {
    expect(needsRenewal(null, 1_700_000_000)).toBe(true);
  });

  it('records a lifetime the answer reported in seconds', async () => {
    // kiro answers `expiresIn` rather than a date, and storing it as a moment is
    // what lets the next turn skip the renewal.
    const { fetch } = stub(() => json({ accessToken: 'n', expiresIn: 3600 }));
    const outcome = await refreshCredential(POLICY, FIELDS, CONTEXT, fetch, 5_000);

    expect(outcome.ok ? outcome.fields['expiresAt'] : null).toBe(
      new Date((1_700_000_000 + 3600) * 1000).toISOString(),
    );
  });
});
