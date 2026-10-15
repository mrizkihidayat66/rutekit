import type { Fetcher } from '@registry';

import { asNumber, asString, failed, parseToken, postForm, type FlowResult, type OauthToken } from './wire.ts';

/**
 * The device sign-in (RFC 8628), as a start and a poll (C3b2).
 *
 * The flow that works where a redirect cannot: a headless host, a container, a
 * machine whose browser is somewhere else. rutekit asks for a device code, hands
 * the operator a short one to type on the provider's own page, and then asks
 * "approved yet" until the answer changes.
 *
 * The poll is the part with a vocabulary. `authorization_pending` means "not
 * yet, ask again", `slow_down` means "ask less often", and everything else means
 * stop — which is why `pollDeviceToken` answers with a status rather than
 * collapsing all three into a sentence.
 */

/** RFC 8628's grant type; the only value the token endpoint accepts for a poll. */
export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** The RFC's default poll interval, used when a provider states none. */
const DEFAULT_INTERVAL_SECONDS = 5;
/** Never poll faster than this, whatever the provider says. */
const MIN_INTERVAL_SECONDS = 1;
/** The RFC's default lifetime, used when a provider states none. */
const DEFAULT_EXPIRES_SECONDS = 600;

export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  /** The page the operator types the code into. */
  readonly verificationUri: string;
  readonly intervalSeconds: number;
  /** Epoch ms after which the device code is dead and the poll must stop. */
  readonly expiresAtMs: number;
}

export interface DeviceStartRequest {
  readonly deviceCodeUrl: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly fetch: Fetcher;
  readonly now: () => number;
}

export async function startDeviceFlow(
  request: DeviceStartRequest,
): Promise<FlowResult<DeviceAuthorization>> {
  const body = new URLSearchParams({ client_id: request.clientId });
  if (request.scopes.length > 0) body.set('scope', request.scopes.join(' '));

  const result = await postForm(request.deviceCodeUrl, body, request.fetch);
  if (!result.ok) return failed(result.message);

  const payload = result.payload;
  const deviceCode = asString(payload['device_code']);
  const userCode = asString(payload['user_code']);
  // `verification_uri_complete` carries the code inside the URL, so an operator
  // who opens it has nothing left to type. It is preferred when offered, and the
  // code is still reported, because a provider may omit the complete form.
  const verificationUri =
    asString(payload['verification_uri_complete']) ??
    asString(payload['verification_uri']) ??
    asString(payload['verification_url']);

  if (deviceCode === null || userCode === null || verificationUri === null) {
    return failed('The device authorization endpoint answered, but its response could not be read.');
  }

  const interval = asNumber(payload['interval']) ?? DEFAULT_INTERVAL_SECONDS;
  const expiresIn = asNumber(payload['expires_in']) ?? DEFAULT_EXPIRES_SECONDS;

  return {
    ok: true,
    value: {
      deviceCode,
      userCode,
      verificationUri,
      intervalSeconds: Math.max(MIN_INTERVAL_SECONDS, interval),
      expiresAtMs: request.now() + expiresIn * 1000,
    },
  };
}

/** What one poll of the token endpoint came back with. */
export type DevicePoll =
  | { readonly status: 'token'; readonly token: OauthToken }
  | { readonly status: 'pending' }
  | { readonly status: 'slow_down' }
  | { readonly status: 'failed'; readonly message: string };

export interface DevicePollRequest {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly deviceCode: string;
  readonly fetch: Fetcher;
  readonly now: () => number;
}

export async function pollDeviceToken(request: DevicePollRequest): Promise<DevicePoll> {
  const body = new URLSearchParams({
    grant_type: DEVICE_CODE_GRANT,
    device_code: request.deviceCode,
    client_id: request.clientId,
  });

  const result = await postForm(request.tokenUrl, body, request.fetch);
  if (!result.ok) {
    if (result.errorCode === 'authorization_pending') return { status: 'pending' };
    if (result.errorCode === 'slow_down') return { status: 'slow_down' };
    return { status: 'failed', message: result.message };
  }

  const token = parseToken(result.payload, request.now);
  if (token === null) {
    return { status: 'failed', message: 'The token endpoint answered, but its response carried no token.' };
  }
  return { status: 'token', token };
}
