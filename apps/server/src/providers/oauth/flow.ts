import { withQuery, type Fetcher } from '@registry';

import { postToken, type FlowResult, type OauthToken } from './wire.ts';

/**
 * The browser sign-in, as three calls (C3b2).
 *
 * `buildAuthorizeUrl` is the only one that is not a network call: it is a pure
 * assembly of the URL the operator is sent to, which is what lets a test assert
 * the exact query string a provider will see. The other two are the exchange and
 * the renewal, and both go through `wire.ts` so neither has an opinion about how
 * a refusal is reported.
 *
 * The renewal lives here rather than in the pool (C5) because it is the same
 * endpoint, the same body shape and the same credential as the exchange; the
 * pool decides *when* to renew, not how.
 */

export interface AuthorizeUrlRequest {
  readonly authorizeUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly state: string;
  /** Null when the manifest turned PKCE off, which is how the older providers are declared. */
  readonly codeChallenge: string | null;
  /** Static parameters the provider requires, e.g. `access_type=offline`. */
  readonly extraParams: Readonly<Record<string, string>>;
}

export function buildAuthorizeUrl(request: AuthorizeUrlRequest): string {
  const params: Record<string, string> = {
    response_type: 'code',
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    state: request.state,
  };
  if (request.scopes.length > 0) params['scope'] = request.scopes.join(' ');
  if (request.codeChallenge !== null) {
    params['code_challenge'] = request.codeChallenge;
    params['code_challenge_method'] = 'S256';
  }

  // The manifest's own parameters go last: a provider that requires something
  // rutekit would not send by default has the final word on its own URL.
  return withQuery(request.authorizeUrl, { ...params, ...request.extraParams });
}

export interface ExchangeRequest {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string | null;
  readonly code: string;
  /** The verifier whose hash travelled as `code_challenge`; null for a flow without PKCE. */
  readonly codeVerifier: string | null;
  readonly redirectUri: string;
  readonly fetch: Fetcher;
  readonly now: () => number;
}

/**
 * Trade the code for a token.
 *
 * `redirect_uri` is repeated here because RFC 6749 requires it to match the one
 * the authorize request carried — a provider that saw two different ones refuses
 * the exchange, which is the check that stops a code being redeemed by whoever
 * happened to intercept the redirect.
 */
export async function exchangeCode(request: ExchangeRequest): Promise<FlowResult<OauthToken>> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: request.code,
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
  });
  if (request.codeVerifier !== null) body.set('code_verifier', request.codeVerifier);
  if (request.clientSecret !== null) body.set('client_secret', request.clientSecret);

  return postToken(request.tokenUrl, body, request.fetch, request.now);
}

export interface RefreshRequest {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string | null;
  readonly refreshToken: string;
  readonly fetch: Fetcher;
  readonly now: () => number;
}

/**
 * Renew an access token. No redirect and no verifier: the refresh token is the
 * whole of the proof, which is why the pool treats it as the credential it is.
 */
export async function refreshToken(request: RefreshRequest): Promise<FlowResult<OauthToken>> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: request.refreshToken,
    client_id: request.clientId,
  });
  if (request.clientSecret !== null) body.set('client_secret', request.clientSecret);

  return postToken(request.tokenUrl, body, request.fetch, request.now);
}
