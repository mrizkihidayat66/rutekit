import type { ClientSurface } from '@translator';
import { openAiErrorBody, renderError } from '@translator';
import type { ProviderManifest } from '@registry';
import { classifyFailure } from '@registry';

import { AppError } from '@server/errors.ts';

/**
 * What a provider's refusal means to a `/v1` client (C4.6).
 *
 * The manifest owns the vocabulary — the same 429 is a rate limit at one
 * upstream and a spent balance at another — so `classifyFailure` decides, and
 * this maps its answer onto the error kinds a client already understands. A
 * failure no rule claims stays `upstream_error` and quotes the status, because
 * admitting the manifest is incomplete beats inventing a class for it.
 *
 * The provider's own words never reach the client. An upstream body is
 * attacker-influenced in the general case and routinely echoes the request, so
 * the message is rutekit's and the detail stays in the log.
 */

/** The provider's `Retry-After`, in seconds, when it sent a usable one. */
export function retryAfterOf(headers: Headers): number | null {
  const raw = headers.get('retry-after');
  if (raw === null) return null;

  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);

  // The header may be an HTTP date instead of a delta. A past date means "now",
  // which is the same instruction a zero carries.
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

export function upstreamFailure(
  manifest: ProviderManifest,
  status: number,
  body: string,
  retryAfterSeconds: number | null,
): AppError {
  const fields = { provider: manifest.id, retryAfterSeconds };

  if (status === 504 || status === 408) {
    return AppError.timeout(`${manifest.name} ran out of time answering.`, fields);
  }

  const failure = classifyFailure(manifest, { status, body });
  if (failure === null) {
    return AppError.upstreamError(`${manifest.name} answered HTTP ${status}.`, fields);
  }

  switch (failure.class) {
    case 'rate_limit':
      return new AppError('rate_limit', `${manifest.name} is rate-limiting this account.`, fields);
    case 'quota':
      return new AppError(
        'quota_exhausted',
        `${manifest.name} says this account has spent its quota.`,
        fields,
      );
    case 'auth':
      return AppError.upstreamError(`${manifest.name} refused this account's credential.`, fields);
    case 'transient':
      return AppError.upstreamError(
        `${manifest.name} could not serve the request right now (HTTP ${status}).`,
        fields,
      );
  }
}

/** A response body as JSON, or null when it was not JSON at all. */
export function asJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * The surface a `/v1` path belongs to, or null when it is not one of the four.
 *
 * Read off the path rather than carried on the context because the error handler
 * runs for failures raised before any route body did — a key that expired between
 * the guard and the handler, a body the policy refused. The path is the one thing
 * every one of those failures still has.
 *
 * `/chat/completions` is tested before `/completions` for the obvious reason: the
 * first ends with the second, and the order of these two lines is the whole
 * correctness of the function.
 */
export function surfaceForPath(path: string): ClientSurface | null {
  if (path.endsWith('/chat/completions')) return 'chat-completions';
  if (path.endsWith('/messages')) return 'messages';
  if (path.endsWith('/responses')) return 'responses';
  if (path.endsWith('/completions')) return 'completions';
  return null;
}

/**
 * The `/v1` error envelope, in the client's own dialect.
 *
 * `errorLifecycle` renders the console's envelope on every path, and `/v1` is not
 * the console: an SDK reading `{ error: { message, type } }` would find the
 * console's `{ error: { kind, message, requestId } }` and report a parse failure
 * instead of the provider's answer. So the data plane carries its own handler and
 * renders through `renderError` — the same function the success path uses, so an
 * error and a result cannot disagree about which dialect they are speaking.
 *
 * A path that names no surface (a bad URL under `/v1`) gets the OpenAI envelope,
 * because that is the dialect of the namespace rather than of any one route.
 */
export function v1ErrorResponse(
  path: string,
  error: AppError,
  requestId: string | null,
): Response {
  const apiError = error.toApiError(requestId);
  const surface = surfaceForPath(path);
  const body = surface === null ? openAiErrorBody(apiError) : renderError(surface, apiError);

  const headers: Record<string, string> = {};
  if (error.retryAfterSeconds !== null) {
    headers['retry-after'] = String(error.retryAfterSeconds);
  }
  return Response.json(body, { status: error.status, headers });
}
