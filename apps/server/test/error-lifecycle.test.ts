import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { apiErrorSchema } from '@contracts';

import { AppError } from '@server/errors.ts';
import { errorLifecycle, notFoundHandler, toAppError } from '@server/ingress/error-lifecycle.ts';
import { requestContext } from '@server/ingress/request-context.ts';
import { silentLogger } from '@server/observability/logger.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The last stage (C1.4, R5.9).
 *
 * The thing under test is not "does an error produce an error response" — it is
 * that *whatever* went wrong leaves the server looking the same, and that the
 * one detail a client must never receive (the internal message, the stack, the
 * cause) does not escape.
 */

const deps = { logger: silentLogger() } as unknown as AppDeps;

/**
 * Pull the error envelope out of a response. `Response.json()` is typed
 * `unknown` here (Bun's `Response`, no DOM lib), so the cast is the seam where
 * the wire format is asserted to be what the contract says.
 */
async function errorOf(response: Response) {
  const body = (await response.json()) as { error: unknown };
  return apiErrorSchema.parse(body.error);
}

describe('toAppError', () => {
  it('passes an AppError through unchanged', () => {
    const original = AppError.notFound('no such thing');
    expect(toAppError(original)).toBe(original);
  });

  it('maps an HTTPException to the matching kind, keeping its status', () => {
    const notFound = toAppError(new HTTPException(404));
    expect(notFound.kind).toBe('not_found');
    expect(notFound.status).toBe(404);

    const unprocessable = toAppError(new HTTPException(422));
    expect(unprocessable.kind).toBe('invalid_request');
    expect(unprocessable.status).toBe(422);

    const unavailable = toAppError(new HTTPException(503));
    expect(unavailable.kind).toBe('unavailable');
    expect(unavailable.status).toBe(503);

    const timeout = toAppError(new HTTPException(504));
    expect(timeout.kind).toBe('timeout');
    expect(timeout.status).toBe(504);
  });

  it('treats an unrecognised throw as an internal error', () => {
    const boom = new Error('driver said: /var/lib/rutekit.sqlite is locked');
    const appError = toAppError(boom);

    expect(appError.kind).toBe('internal');
    expect(appError.status).toBe(500);
    // The original is kept aside for the log, not for the client.
    expect(appError.cause).toBe(boom);
  });

  it('treats a non-Error throw as internal too', () => {
    expect(toAppError('a bare string').kind).toBe('internal');
    expect(toAppError(undefined).kind).toBe('internal');
  });
});

describe('errorLifecycle', () => {
  function appWith(handler: (c: Context<AppEnv>) => never) {
    const app = new Hono<AppEnv>();
    app.use('*', requestContext());
    app.get('/boom', handler);
    app.onError(errorLifecycle(deps));
    app.notFound(notFoundHandler());
    return app;
  }

  it('answers an AppError with its own status and envelope', async () => {
    const app = appWith(() => {
      throw AppError.notFound('No provider with that id.');
    });

    const response = await app.request('/boom');
    expect(response.status).toBe(404);

    const error = await errorOf(response);
    expect(error.kind).toBe('not_found');
    expect(error.message).toBe('No provider with that id.');
    expect(error.requestId).toBeTypeOf('string');
    expect(error.requestId).not.toBe('');
  });

  it('sets retry-after when the error carries one', async () => {
    const app = appWith(() => {
      throw AppError.rateLimit(30);
    });

    const response = await app.request('/boom');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
  });

  it('hides the internal message, the stack and the cause', async () => {
    const app = appWith(() => {
      throw new Error('SECRET /etc/passwd leaked here');
    });

    const response = await app.request('/boom');
    expect(response.status).toBe(500);

    const raw = await response.text();
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('passwd');
    expect(raw).not.toContain('stack');
    expect(raw).not.toContain('cause');

    const error = apiErrorSchema.parse((JSON.parse(raw) as { error: unknown }).error);
    expect(error.kind).toBe('internal');
    expect(error.message).toBe('Something went wrong.');
    expect(error.requestId).toBeTypeOf('string');
  });

  it('answers an unknown path with a 404 in the same envelope', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', requestContext());
    app.onError(errorLifecycle(deps));
    app.notFound(notFoundHandler());

    const response = await app.request('/does-not-exist');
    expect(response.status).toBe(404);

    const error = await errorOf(response);
    expect(error.kind).toBe('not_found');
    expect(error.message).toContain('/does-not-exist');
    expect(error.requestId).toBeTypeOf('string');
  });
});
