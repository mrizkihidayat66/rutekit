import type { Fetcher, HttpResponse } from '@registry';

/**
 * The form-encoded POST, and the one shape every OAuth answer is read into
 * (C3b2).
 *
 * The catalogue's four sign-in providers speak three different endpoints — an
 * authorize redirect, a device authorization request, a token exchange — but two
 * of them are the same call wearing a different body, and all three answer with
 * either a JSON object or RFC 6749's error object. Writing that once is what
 * keeps a provider quirk from becoming a fork of the whole flow.
 *
 * Nothing throws. An unreachable host, a refusal rutekit can name, a body it
 * cannot read: each becomes a failure carrying the sentence the console would
 * otherwise have to invent. That is the same contract `discovery.ts` keeps, for
 * the same reason — a caller's job is to decide what to do about a failure, not
 * to write the failure down twice.
 *
 * The error *code* travels beside the message because two of them are not
 * failures at all: RFC 8628 answers a poll that is simply too early with
 * `authorization_pending`, and a caller that only saw the sentence would have to
 * pattern-match English to tell "keep waiting" from "give up".
 */

const FORM_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/x-www-form-urlencoded',
  accept: 'application/json',
};

/** What a token endpoint returns, normalised. */
export interface OauthToken {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly tokenType: string | null;
  readonly scope: string | null;
  /** Absolute ISO instant, or null when the provider stated no lifetime. */
  readonly expiresAt: string | null;
  /** The signed identity token, when the provider issues one; read for the email only. */
  readonly idToken: string | null;
}

export type FlowResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

export type FormResult =
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly message: string; readonly errorCode: string | null };

export function failed<T>(message: string): FlowResult<T> {
  return { ok: false, message };
}

/** POST a form body and read the answer, without yet deciding what it means. */
export async function postForm(
  url: string,
  body: URLSearchParams,
  fetch: Fetcher,
): Promise<FormResult> {
  let response: HttpResponse;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: body.toString(),
    });
  } catch (error) {
    return { ok: false, message: `Could not reach the endpoint: ${describe(error)}`, errorCode: null };
  }

  const text = await readBody(response);
  const payload = asRecord(text);

  if (response.status >= 400) {
    const code = payload === null ? null : asString(payload['error']);
    return {
      ok: false,
      message: describeRefusal(payload) ?? `The endpoint answered HTTP ${response.status}.`,
      errorCode: code,
    };
  }

  if (payload === null) {
    return {
      ok: false,
      message: 'The endpoint answered, but its response could not be read.',
      errorCode: null,
    };
  }
  return { ok: true, payload };
}

/** `postForm` for the two calls whose answer is a token. */
export async function postToken(
  url: string,
  body: URLSearchParams,
  fetch: Fetcher,
  now: () => number,
): Promise<FlowResult<OauthToken>> {
  const result = await postForm(url, body, fetch);
  if (!result.ok) return failed(result.message);

  const token = parseToken(result.payload, now);
  if (token === null) return failed('The token endpoint answered, but its response carried no token.');
  return { ok: true, value: token };
}

/**
 * A token object, or null when the body is not one. `access_token` is the only
 * field that must be there; everything else a provider may simply omit.
 */
export function parseToken(payload: Record<string, unknown>, now: () => number): OauthToken | null {
  const accessToken = asString(payload['access_token']);
  if (accessToken === null) return null;

  const seconds = asNumber(payload['expires_in']);
  return {
    accessToken,
    refreshToken: asString(payload['refresh_token']),
    tokenType: asString(payload['token_type']),
    scope: asString(payload['scope']),
    expiresAt: seconds === null ? null : new Date(now() + seconds * 1000).toISOString(),
    idToken: asString(payload['id_token']),
  };
}

/** A non-empty string, or null — the coercion every JSON field here needs. */
export function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A finite number, accepting the numeric strings some providers send. */
export function asNumber(value: unknown): number | null {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function asRecord(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

export async function readBody(response: HttpResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'an unknown error';
}

/**
 * The refusal as a sentence, when the body named a reason.
 *
 * RFC 6749 puts the machine-readable cause in `error` and the human one in
 * `error_description`; without this a rejected exchange is indistinguishable
 * from any other 400, and the operator is left guessing whether the code expired,
 * the redirect did not match, or the client was not registered.
 */
function describeRefusal(payload: Record<string, unknown> | null): string | null {
  if (payload === null) return null;
  const code = asString(payload['error']);
  if (code === null) return null;
  const description = asString(payload['error_description']);
  return description === null
    ? `The endpoint refused the request (${code}).`
    : `The endpoint refused the request (${code}: ${description}).`;
}
