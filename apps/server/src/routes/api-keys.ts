import { Hono } from 'hono';
import type { Ok } from '@contracts';
import {
  apiKeyInputSchema,
  apiKeyUpdateSchema,
  apiKeysQuerySchema,
  consolePaths,
} from '@contracts';

import { jsonBody } from '@server/ingress/validate.ts';
import { AppError } from '@server/errors.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The API-key console (FR-6).
 *
 * All five routes sit behind the session guard — a key can only be managed by
 * the operator, never by another key — and every one of them is thin: validate,
 * call the service, return its answer.
 *
 * The query is parsed rather than trusted, because `limit`, `sort` and `state`
 * all reach a slice or a comparison and an unvalidated `sort` would be a lookup
 * miss at best.
 */
export function apiKeyRoutes(deps: AppDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { apiKeys } = deps;

  router.get(consolePaths.apiKeys, (c) => {
    const parsed = apiKeysQuerySchema.safeParse({
      q: c.req.query('q') ?? '',
      state: c.req.query('state') ?? null,
      sort: c.req.query('sort') ?? null,
      direction: c.req.query('direction') ?? undefined,
      limit: c.req.query('limit') ?? undefined,
      cursor: c.req.query('cursor') ?? null,
    });
    if (!parsed.success) throw AppError.invalidRequest('The list query was not valid.');
    return c.json(apiKeys.list(parsed.data));
  });

  router.post(consolePaths.apiKeys, jsonBody(apiKeyInputSchema), (c) =>
    c.json(apiKeys.create(c.req.valid('json')), 201),
  );

  router.patch(consolePaths.apiKey, jsonBody(apiKeyUpdateSchema), (c) =>
    c.json(apiKeys.update(c.req.param('id'), c.req.valid('json'))),
  );

  router.post(consolePaths.apiKeyRevoke, (c) => c.json(apiKeys.revoke(c.req.param('id'))));

  router.delete(consolePaths.apiKey, (c) => {
    apiKeys.remove(c.req.param('id'));
    return c.json({ ok: true } satisfies Ok);
  });

  return router;
}
