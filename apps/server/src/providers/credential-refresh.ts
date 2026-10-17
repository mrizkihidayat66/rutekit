import type { ProviderManifest } from '@registry';
import { codecFor } from '@translator';
import type { CodecContext, WireRenewal } from '@translator';

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

/**
 * How a provider renews, which is one of two things.
 *
 * Most renewals are a URL and a JSON body with one value substituted — the
 * manifest can state that completely, and `template` is that case. A provider
 * whose renewal is *signed* cannot be described that way: qoder's exchange
 * carries a session key encrypted to its public key and an MD5 over the headers,
 * so the request is the codec's own arithmetic and the manifest only declares
 * that a renewal exists.
 */
export type RefreshPolicy =
  | {
      readonly kind: 'template';
      readonly url: string;
      /** The JSON body, with `{refreshToken}` substituted from the credential. */
      readonly bodyTemplate: string;
      /** Where the new access token is in the answer. */
      readonly accessTokenField: string;
      /** Where a rotated refresh token is, when the provider rotates. */
      readonly refreshTokenField: string | null;
    }
  | {
      readonly kind: 'wire';
      readonly url: string;
      /** The codec's own request builder, and the reader for its answer. */
      readonly renew: (context: CodecContext) => WireRenewal;
    };

/** A credential that has been renewed, or the reason it could not be. */
export type RefreshOutcome =
  | { readonly ok: true; readonly fields: Record<string, string> }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

/**
 * The manifest's policy, or null when the provider does not offer one.
 *
 * A `wire` declaration with no codec that can renew is null as well: the manifest
 * saying "this provider renews" is not enough if the family has no request
 * builder for it, and pretending otherwise would have the caller wait on a
 * renewal that can never be made.
 */
export function refreshPolicyOf(manifest: ProviderManifest): RefreshPolicy | null {
  const declared = manifest.credentialRefresh;
  if (declared === null) return null;

  if (declared.kind === 'template') {
    return {
      kind: 'template',
      url: declared.url,
      bodyTemplate: declared.bodyTemplate,
      accessTokenField: declared.accessTokenField,
      refreshTokenField: declared.refreshTokenField,
    };
  }

  const renew = codecFor(manifest.endpoint.wireFamily)?.renew;
  if (renew === undefined) return null;
  return { kind: 'wire', url: declared.url, renew };
}

/**
 * How long before an expiry a token is still worth renewing.
 *
 * A token that expires mid-turn is as useless as one that already has, and the
 * clock this compares against is the server's — so a minute of slack costs one
 * early renewal and removes a class of failure that reads as "the provider
 * rejected the credential" when nothing was wrong with it.
 */
const RENEWAL_SKEW_MS = 60_000;

/**
 * Whether a stored expiry says the credential still has life in it.
 *
 * **Renewing on every turn is a cost, not a precaution.** A refresh is a network
 * round trip and, for a rotating provider, a database write; doing it before
 * every request because the token *might* be old is the same mistake as probing
 * quota with a paid call. So a credential with a known, future expiry is left
 * alone, and one whose expiry is unknown (null) is renewed — that is the honest
 * reading of "we cannot tell".
 */
export function needsRenewal(
  expiresAt: string | null,
  nowSeconds: number,
  skewMs = RENEWAL_SKEW_MS,
): boolean {
  if (expiresAt === null) return true;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return true;
  return at - nowSeconds * 1000 <= skewMs;
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
  context: CodecContext,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  timeoutMs: number,
): Promise<RefreshOutcome> {
  const refreshToken = fields['refreshToken'] ?? '';
  if (refreshToken === '') {
    // Nothing to spend. Not retryable: another attempt has the same nothing.
    return { ok: false, reason: 'this account has no refresh token', retryable: false };
  }

  let url = policy.url;
  let body: string;
  let headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  let read: (answer: unknown) => Record<string, string> | null;

  if (policy.kind === 'template') {
    body = policy.bodyTemplate.replaceAll('{refreshToken}', JSON.stringify(refreshToken));
    const accessTokenField = policy.accessTokenField;
    const refreshTokenField = policy.refreshTokenField;
    read = (answer) => {
      const record =
        answer !== null && typeof answer === 'object'
          ? (answer as Record<string, unknown>)
          : {};
      const token = record[accessTokenField];
      if (typeof token !== 'string' || token === '') return null;

      const changed: Record<string, string> = { accessToken: token };
      if (refreshTokenField !== null) {
        const rotated = record[refreshTokenField];
        if (typeof rotated === 'string' && rotated !== '') changed['refreshToken'] = rotated;
      }
      return changed;
    };
  } else {
    // The wire builds it, because a signed renewal is not a string template. It
    // is handed the account's fields through the context, so the codec signs
    // with the machine identity this credential was imported with.
    const renewal = policy.renew(context);
    url = renewal.url;
    body = renewal.body;
    headers = { ...renewal.headers };
    read = renewal.read;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
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
  const changed = read(payload);
  if (changed === null) {
    return { ok: false, reason: 'the refresh answered without an access token', retryable: false };
  }

  // A provider that reports a new expiry should have it recorded, so the next
  // turn can decide without spending a refresh it does not need.
  const record =
    payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  for (const name of ['expiresAt', 'expires_at']) {
    const value = record[name];
    if (typeof value === 'string' && value !== '') changed[name] = value;
  }

  // A lifetime in seconds is the shape most providers answer with — kiro's is
  // `expiresIn` — and storing it as an absolute moment is what lets a later turn
  // tell whether the token is worth renewing at all.
  const lifetime = record['expiresIn'];
  if (typeof lifetime === 'number' && Number.isFinite(lifetime) && lifetime > 0) {
    changed['expiresAt'] = new Date((context.now() + lifetime) * 1000).toISOString();
  }

  return { ok: true, fields: changed };
}
