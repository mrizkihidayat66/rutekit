import type { JsonBodyType } from 'msw';
import type { z } from 'zod';
import { HttpResponse } from 'msw';
import { CONSOLE_API_PREFIX, consolePaths } from '@contracts';

/**
 * Shared plumbing for the console handlers.
 *
 * `respond` runs the body back through the contract's own schema before it goes
 * out. That is deliberate: a handler that drifts from `packages/contracts` fails
 * loudly in the mock layer rather than silently shipping a shape the real server
 * will never produce — which is the whole reason the frontend can be built
 * before the backend exists.
 */

export type PathName = keyof typeof consolePaths;

/** Build an MSW route pattern from a `consolePaths` template. */
export function route(name: PathName): string {
  return `${CONSOLE_API_PREFIX}${consolePaths[name]}`;
}

export function respond(schema: z.ZodType, data: unknown): Response {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    // Surfacing this as a 500 is intentional: the mock produced a body its own
    // contract rejects, and a red console entry is the fastest way to see it.
    return HttpResponse.json(
      {
        error: {
          kind: 'internal',
          message: `mock response failed contract validation: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
          provider: null,
          retryAfterSeconds: null,
          requestId: null,
        },
      },
      { status: 500 },
    );
  }
  return HttpResponse.json(parsed.data as JsonBodyType);
}

export function ok(): Response {
  return HttpResponse.json({ ok: true });
}

/**
 * Serve bytes verbatim rather than as JSON.
 *
 * Used by the Studio asset file route: an asset's `url` is a real media URL, and
 * the gallery's full-size view loads it with `<img>` or `<video>`, so the mock
 * has to answer with the bytes and the media type instead of a contract body.
 */
export function fileResponse(body: string, contentType: string): Response {
  return new HttpResponse(body, { headers: { 'content-type': contentType } });
}

export function consoleError(
  status: number,
  kind:
    'invalid_request' | 'not_found' | 'authentication' | 'permission' | 'rate_limit' | 'internal',
  message: string,
): Response {
  return HttpResponse.json(
    { error: { kind, message, provider: null, retryAfterSeconds: null, requestId: null } },
    { status },
  );
}

export function notFound(what: string, id: string): Response {
  return consoleError(404, 'not_found', `${what} "${id}" was not found`);
}

export function badRequest(message: string): Response {
  return consoleError(400, 'invalid_request', message);
}

/**
 * The request was well-formed but the state refuses it — a duplicate id, or a
 * write aimed at something the provider owns. Distinct from `badRequest` so a
 * form can tell "you typed this wrong" from "that name is already taken".
 */
export function conflict(message: string): Response {
  return consoleError(409, 'invalid_request', message);
}

/* ---- query-string readers ---- */

export interface ListParams {
  cursor: string | null;
  limit: number;
  sort: string | null;
  direction: 'asc' | 'desc';
  q: string;
}

export function searchParams(request: Request): URLSearchParams {
  return new URL(request.url).searchParams;
}

export function strParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  return value === null || value === '' ? null : value;
}

export function boolParam(params: URLSearchParams, key: string, fallback = false): boolean {
  const value = params.get(key);
  if (value === null) return fallback;
  return value === 'true' || value === '1';
}

export function numParam(params: URLSearchParams, key: string, fallback: number): number {
  const value = params.get(key);
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function listParams(request: Request): ListParams {
  const params = searchParams(request);
  const limit = Math.min(200, Math.max(1, numParam(params, 'limit', 50)));
  const direction = params.get('direction') === 'asc' ? 'asc' : 'desc';
  return {
    cursor: strParam(params, 'cursor'),
    limit,
    sort: strParam(params, 'sort'),
    direction,
    q: params.get('q') ?? '',
  };
}

/** Parse a request body, returning `undefined` rather than throwing on junk. */
export async function bodyOf<T>(request: Request): Promise<T | undefined> {
  try {
    return (await request.json()) as T;
  } catch {
    return undefined;
  }
}

/* ---- entity construction ---- */

export function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Kebab-case slug, matching `slugSchema`; never returns an empty string. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug === '' ? 'item' : slug;
}

/** A named `:param` of an MSW path template, always a string. */
export function paramOf(
  params: Readonly<Record<string, string | readonly string[] | undefined>>,
  name: string,
): string {
  const value = params[name];
  return typeof value === 'string' ? value : (value?.[0] ?? '');
}

/** The `:id` of an MSW path template, always a string. */
export function paramId(
  params: Readonly<Record<string, string | readonly string[] | undefined>>,
): string {
  return paramOf(params, 'id');
}
