import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';

import { AppError } from '@server/errors.ts';
import { DEFAULT_MAX_BODY_BYTES, bodyPolicy } from '@server/ingress/body-policy.ts';
import type { AppEnv } from '@server/types.ts';

/**
 * What a request is allowed to be before anything reads it (C1.4).
 *
 * The middleware is driven directly rather than through `app.request`: the
 * length check reads `Content-Length`, and a `Request` built from a fetch-style
 * init drops that header as forbidden, so the branch under test would never be
 * reached through the normal path.
 */

function contextFor(headers: Record<string, string>, method = 'POST'): Context<AppEnv> {
  return {
    req: {
      method,
      header: (name: string) => headers[name.toLowerCase()],
    },
  } as unknown as Context<AppEnv>;
}

const pass = (): Promise<void> => Promise.resolve();

describe('bodyPolicy', () => {
  it('lets a request with no body through', async () => {
    await expect(bodyPolicy()(contextFor({}, 'GET'), pass)).resolves.toBeUndefined();
  });

  it('lets a JSON body through', async () => {
    const c = contextFor({ 'content-type': 'application/json', 'content-length': '42' });
    await expect(bodyPolicy()(c, pass)).resolves.toBeUndefined();
  });

  it('lets a multipart upload through', async () => {
    const c = contextFor({ 'content-type': 'multipart/form-data; boundary=----x' });
    await expect(bodyPolicy()(c, pass)).resolves.toBeUndefined();
  });

  it('refuses a body over the declared cap with 413', async () => {
    const c = contextFor({ 'content-length': String(DEFAULT_MAX_BODY_BYTES + 1) });

    await expect(bodyPolicy()(c, pass)).rejects.toMatchObject({
      kind: 'invalid_request',
      status: 413,
    });
  });

  it('accepts a body exactly at the cap', async () => {
    const c = contextFor({ 'content-length': String(DEFAULT_MAX_BODY_BYTES) });
    await expect(bodyPolicy()(c, pass)).resolves.toBeUndefined();
  });

  it('refuses a mislabelled body with 415', async () => {
    const c = contextFor({ 'content-type': 'text/plain' });

    await expect(bodyPolicy()(c, pass)).rejects.toMatchObject({
      kind: 'invalid_request',
      status: 415,
    });
  });

  it('refuses a content-length that is not a non-negative integer', async () => {
    await expect(bodyPolicy()(contextFor({ 'content-length': 'lots' }), pass)).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('honours a lower cap when one is given', async () => {
    const c = contextFor({ 'content-length': '2048' });

    await expect(bodyPolicy({ maxBytes: 1024 })(c, pass)).rejects.toMatchObject({ status: 413 });
  });
});
