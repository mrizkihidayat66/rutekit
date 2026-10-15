import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { ConsoleError, ErrorKind } from '@contracts';
import { AppError, isAppError } from '@server/errors.ts';
import { v1ErrorResponse } from '@server/providers/dispatch-errors.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The last stage: turning whatever went wrong into an error envelope.
 *
 * One handler decides the shape, so every failure — a thrown `AppError`, a Hono
 * `HTTPException` from a validator, or a genuine bug — leaves the server looking
 * the same to a client. The stack trace and the underlying cause stay in the
 * log, keyed by the same request id the client was given (R5.9).
 *
 * It renders two dialects, and the path chooses. `/v1` is spoken by an SDK that
 * reads `{ error: { message, type } }`; the console reads
 * `{ error: { kind, message, requestId } }`. The branch is here rather than on the
 * `/v1` router's own `onError` because failures reach this handler from stages the
 * router never sees — the API-key guard, the readiness gate, the not-found handler
 * — and every one of them has to answer in the dialect of the namespace it was
 * addressed to, not of the handler that happened to raise it.
 */

/** True for the data plane, whose errors are the client's SDK's to parse. */
function isDataPlane(path: string): boolean {
  return path === '/v1' || path.startsWith('/v1/');
}

function kindForStatus(status: number): ErrorKind {
  switch (status) {
    case 400:
    case 422:
      return 'invalid_request';
    case 401:
      return 'authentication';
    case 403:
      return 'permission';
    case 404:
      return 'not_found';
    case 429:
      return 'rate_limit';
    case 503:
      return 'unavailable';
    case 504:
      return 'timeout';
    default:
      return status >= 500 ? 'internal' : 'invalid_request';
  }
}

export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof HTTPException) {
    return new AppError(kindForStatus(error.status), error.message, {
      status: error.status,
      cause: error,
    });
  }
  return AppError.internal(error);
}

function requestIdOf(c: Context<AppEnv>): string | null {
  const value = c.get('requestId');
  return typeof value === 'string' && value !== '' ? value : null;
}

function logFailure(deps: AppDeps, appError: AppError, original: unknown, c: Context<AppEnv>): void {
  const fields = {
    requestId: requestIdOf(c),
    method: c.req.method,
    path: c.req.path,
    status: appError.status,
    kind: appError.kind,
  };
  if (appError.status >= 500) {
    // The original is attached here and only here: this is the one place it is
    // both available and safe to write.
    deps.logger.error({ ...fields, err: appError.cause ?? original }, appError.message);
    return;
  }
  deps.logger.warn(fields, appError.message);
}

export function errorLifecycle(deps: AppDeps): ErrorHandler<AppEnv> {
  return (error, c) => {
    const appError = toAppError(error);
    logFailure(deps, appError, error, c);
    if (isDataPlane(c.req.path)) {
      return v1ErrorResponse(c.req.path, appError, requestIdOf(c));
    }
    if (appError.retryAfterSeconds !== null) {
      c.header('retry-after', String(Math.ceil(appError.retryAfterSeconds)));
    }
    const body: ConsoleError = { error: appError.toApiError(requestIdOf(c)) };
    return c.json(body, appError.status as ContentfulStatusCode);
  };
}

export function notFoundHandler(): NotFoundHandler<AppEnv> {
  return (c) => {
    const error = AppError.notFound(`No route for ${c.req.method} ${c.req.path}.`);
    if (isDataPlane(c.req.path)) {
      return v1ErrorResponse(c.req.path, error, requestIdOf(c));
    }
    const body: ConsoleError = { error: error.toApiError(requestIdOf(c)) };
    return c.json(body, 404);
  };
}
