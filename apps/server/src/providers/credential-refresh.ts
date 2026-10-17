import type { ProviderManifest } from '@registry';

/**
 * Renewing an access token before it is spent (C4.6).
 *
 * **A stored credential is not a permanent one.** A provider that issues an access
 * token also issues a refresh token beside it, and expects the client to spend
 * the second when the first stops working. rutekit read `refreshToken` off the
 * envelope and never used it, so an account imported in the morning was dead by
 * the afternoon with no way back except another sign-in — which, for a provider
 * whose accounts came from browser automation, is exactly the expensive thing an
 * operator does not want to repeat.
 *
 * **Refreshing is a provider's own protocol, so it is declared by the manifest.**
 * A provider that supports it says where to ask and what to send; one that does
 * not is left alone. This module is the mechanism, not the policy — it knows how
 * to spend a refresh token and how to recognise a rotated one, and nothing about
 * which provider it is talking to.
 *
 * **A rotated refresh token must be stored.** Providers that rotate return a new
 * one on every refresh, and keeping the old one means the *next* refresh fails
 * with a token that was already spent. That is the failure this file exists to
 * prevent, so the write is part of the result rather than a caller's option.
 */

/** What a manifest says about renewing its tokens. */
export interface RefreshPolicy {
  readonly url: string;
  /** The JSON body, with `{refreshToken}` substituted from the credential. */
  readonly bodyTemplate: string;
  /** Where the new access token is in the answer. */
  readonly accessTokenField: string;
  /** Where a rotated refresh token is, when the provider rotates. */
  readonly refreshTokenField: string | null;
}

/** A credential that has been renewed, or the reason it could not be. */
export type RefreshOutcome =
  | { readonly ok: true; readonly fields: Record<string, string> }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

/** The manifest's policy, or null when the provider does not offer one. */
export function refreshPolicyOf(manifest: ProviderManifest): RefreshPolicy | null {
  const declared = manifest.credentialRefresh;
  if (declared === null) return null;
  return {
    url: declared.url,
    bodyTemplate: declared.bodyTemplate,
    accessTokenField: declared.accessTokenField,
    refreshTokenField: declared.refreshTokenField,
  };
}

/**
 * Spend a refresh token, and hand back the fields that changed.
 *
 * The returned record is merged over the stored one rather than replacing it: a
 * provider returns what it renewed and nothing else, and the account's other
 * fields — a user id, a profile — are still true.
 */
export async function refreshCredential(
  policy: RefreshPolicy,
  fields: Readonly<Record<string, string>>,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  timeoutMs: number,
): Promise<RefreshOutcome> {
  const refreshToken = fields['refreshToken'] ?? '';
  if (refreshToken === '') {
    // Nothing to spend. Not retryable: another attempt has the same nothing.
    return { ok: false, reason: 'this account has no refresh token', retryable: false };
  }

  const body = policy.bodyTemplate.replaceAll('{refreshToken}', JSON.stringify(refreshToken));

  let response: Response;
  try {
    response = await fetchImpl(policy.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    return {
      ok: false,
      reason: `the refresh endpoint could not be reached: ${cause instanceof Error ? cause.message : 'unknown'}`,
      retryable: true,
    };
  }

  // 5xx and 429 say nothing about the credential, so another attempt may work.
  if (response.status >= 500 || response.status === 429) {
    return { ok: false, reason: `the refresh endpoint failed (${response.status})`, retryable: true };
  }
  if (!response.ok) {
    // A 4xx is the refresh token being dead, which is final.
    return {
      ok: false,
      reason: `the refresh was refused (${response.status}); this account needs a new sign-in`,
      retryable: false,
    };
  }

  const payload: unknown = await response.json().catch(() => null);
  const record =
    payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};

  const accessToken = record[policy.accessTokenField];
  if (typeof accessToken !== 'string' || accessToken === '') {
    return { ok: false, reason: 'the refresh answered without an access token', retryable: false };
  }

  const changed: Record<string, string> = { accessToken };
  if (policy.refreshTokenField !== null) {
    const rotated = record[policy.refreshTokenField];
    if (typeof rotated === 'string' && rotated !== '') changed['refreshToken'] = rotated;
  }

  // A provider that reports a new expiry should have it recorded, so the next
  // turn can decide without spending a refresh it does not need.
  for (const name of ['expiresAt', 'expires_at']) {
    const value = record[name];
    if (typeof value === 'string' && value !== '') changed[name] = value;
  }

  return { ok: true, fields: changed };
}
