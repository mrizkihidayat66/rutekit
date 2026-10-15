import type { z } from 'zod';

import { consoleErrorSchema } from '@contracts';

/**
 * The one place the console talks to the network (RULESET R6.1).
 *
 * Every fetch goes through `apiRequest`, which does three things a bare `fetch`
 * call would leave to each call site to remember: it validates the body against
 * the contract's own schema, it turns a non-2xx response into a typed `ApiError`
 * rather than an `undefined` that surfaces three components later, and it never
 * lets a malformed payload reach a component as a plausible-looking object.
 *
 * During FASE B the requests are answered by the MSW worker; in FASE C the same
 * calls hit Hono, and nothing here changes.
 */

/** A failed console request, carrying the server's own error fields. */
export class ApiError extends Error {
  /** HTTP status, or `0` when the request never left the browser. */
  readonly status: number;
  /** The contract's `errorKind` — `not_found`, `rate_limit`, `internal`, … */
  readonly kind: string;
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    fields: {
      status: number;
      kind: string;
      requestId?: string | null;
      retryAfterSeconds?: number | null;
    },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = fields.status;
    this.kind = fields.kind;
    this.requestId = fields.requestId ?? null;
    this.retryAfterSeconds = fields.retryAfterSeconds ?? null;
  }

  /** Read the console error envelope out of a response, falling back to the status. */
  static fromResponse(response: Response, payload: unknown): ApiError {
    const parsed = consoleErrorSchema.safeParse(payload);
    if (parsed.success) {
      const { kind, message, requestId, retryAfterSeconds } = parsed.data.error;
      return new ApiError(message, { status: response.status, kind, requestId, retryAfterSeconds });
    }
    return new ApiError(`Request failed with status ${response.status}`, {
      status: response.status,
      kind: 'internal',
    });
  }
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

/**
 * Perform a console request and validate the answer against `schema`.
 *
 * The schema is the contract's, not a hand-written mirror of it, so a shape
 * change in `packages/contracts` breaks here at the boundary instead of
 * somewhere deeper where the cause is no longer visible.
 */
export async function apiRequest<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
  const init: RequestInit = { method: options.method ?? 'GET' };
  if (options.signal !== undefined) init.signal = options.signal;
  if (options.body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError('Could not reach the server', { status: 0, kind: 'network' });
  }

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) throw ApiError.fromResponse(response, payload);

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(`Response from ${path} did not match its contract`, {
      status: response.status,
      kind: 'internal',
    });
  }
  return parsed.data;
}

export function apiGet<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  return apiRequest(path, schema, signal === undefined ? {} : { signal });
}

export function apiPost<T>(path: string, schema: z.ZodType<T>, body: unknown, signal?: AbortSignal): Promise<T> {
  return apiRequest(path, schema, signal === undefined ? { method: 'POST', body } : { method: 'POST', body, signal });
}

export function apiPatch<T>(path: string, schema: z.ZodType<T>, body: unknown, signal?: AbortSignal): Promise<T> {
  return apiRequest(path, schema, signal === undefined ? { method: 'PATCH', body } : { method: 'PATCH', body, signal });
}

export function apiDelete<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  return apiRequest(path, schema, signal === undefined ? { method: 'DELETE' } : { method: 'DELETE', signal });
}

export type QueryValue = string | number | boolean | null | undefined;

/**
 * Append a query string, dropping empty values. An absent filter is spelled by
 * leaving the key out entirely, which is what the handlers treat as "no filter".
 */
export function withQuery(path: string, params: Readonly<Record<string, QueryValue>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query === '' ? path : `${path}?${query}`;
}
