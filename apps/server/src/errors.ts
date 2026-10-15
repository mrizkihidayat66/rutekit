import type { ApiError, ErrorKind } from '@contracts';

/**
 * The one error type the backend raises.
 *
 * A route throws an `AppError`; the error-lifecycle middleware turns it into the
 * console's `{ error: apiErrorSchema }` envelope. Nothing else in the server
 * decides a status code, and nothing ever hands a stack trace or a raw driver
 * message to a client (R5.9) — the message on an `AppError` is written for the
 * person reading it, and the cause is kept aside for the log.
 */

/** HTTP status for each error kind. One table, so the mapping is auditable. */
const STATUS_BY_KIND: Record<ErrorKind, number> = {
  invalid_request: 400,
  authentication: 401,
  permission: 403,
  not_found: 404,
  rate_limit: 429,
  quota_exhausted: 429,
  upstream_error: 502,
  timeout: 504,
  unavailable: 503,
  shutting_down: 503,
  internal: 500,
  aborted: 499,
};

/** Copy used when the raising site has nothing more specific to say. */
const DEFAULT_MESSAGE: Record<ErrorKind, string> = {
  invalid_request: 'The request was not valid.',
  authentication: 'Authentication is required.',
  permission: 'This action is not permitted.',
  not_found: 'Not found.',
  rate_limit: 'Too many requests.',
  quota_exhausted: 'The quota for this credential is exhausted.',
  upstream_error: 'The upstream provider returned an error.',
  timeout: 'The request timed out.',
  unavailable: 'This feature is not available yet.',
  shutting_down: 'The server is shutting down.',
  internal: 'Something went wrong.',
  aborted: 'The request was aborted.',
};

export interface AppErrorFields {
  /** Provider id when the failure originated upstream. */
  readonly provider?: string | null;
  readonly retryAfterSeconds?: number | null;
  /** Override the table, for the rare case a route needs a different status. */
  readonly status?: number;
  /** Internal detail for the log only. Never serialised to a client. */
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly kind: ErrorKind;
  readonly status: number;
  readonly provider: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(kind: ErrorKind, message?: string, fields: AppErrorFields = {}) {
    super(message ?? DEFAULT_MESSAGE[kind]);
    this.name = 'AppError';
    this.kind = kind;
    this.status = fields.status ?? STATUS_BY_KIND[kind];
    this.provider = fields.provider ?? null;
    this.retryAfterSeconds = fields.retryAfterSeconds ?? null;
    if (fields.cause !== undefined) this.cause = fields.cause;
  }

  /** The client-facing shape. `requestId` is attached by the error middleware. */
  toApiError(requestId: string | null): ApiError {
    return {
      kind: this.kind,
      message: this.message,
      provider: this.provider,
      retryAfterSeconds: this.retryAfterSeconds,
      requestId,
    };
  }

  static invalidRequest(message: string): AppError {
    return new AppError('invalid_request', message);
  }

  static authentication(message = DEFAULT_MESSAGE.authentication): AppError {
    return new AppError('authentication', message);
  }

  static permission(message: string): AppError {
    return new AppError('permission', message);
  }

  static notFound(message: string): AppError {
    return new AppError('not_found', message);
  }

  static rateLimit(retryAfterSeconds: number | null = null): AppError {
    return new AppError('rate_limit', undefined, { retryAfterSeconds });
  }

  /**
   * A provider that answered, badly. The message is the provider's own words
   * where it said anything readable, because an operator debugging a 502 needs
   * to know which upstream said what.
   */
  static upstreamError(message: string, fields: AppErrorFields = {}): AppError {
    return new AppError('upstream_error', message, fields);
  }

  /** A call that ran out of the clock, ours or the provider's. */
  static timeout(message?: string, fields: AppErrorFields = {}): AppError {
    return new AppError('timeout', message, fields);
  }

  static unavailable(message: string): AppError {
    return new AppError('unavailable', message);
  }

  static shuttingDown(): AppError {
    return new AppError('shutting_down', undefined, { retryAfterSeconds: 1 });
  }

  /**
   * An unexpected failure. The caller's `cause` is logged; the client is told
   * only that something went wrong, because a driver message or a path on disk
   * is exactly the kind of detail an attacker wants from a 500.
   */
  static internal(cause?: unknown): AppError {
    return new AppError('internal', undefined, cause === undefined ? {} : { cause });
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
