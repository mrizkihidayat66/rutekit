import { Hono } from 'hono';
import type { Ok } from '@contracts';
import {
  accountInputSchema,
  accountUpdateSchema,
  accountsQuerySchema,
  bulkAccountActionSchema,
  consolePaths,
  quotaCheckBodySchema,
} from '@contracts';

import { createQuotaService } from '@server/accounts/quota.ts';
import { AppError } from '@server/errors.ts';
import { jsonBody } from '@server/ingress/validate.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The account pool's console routes (FR-3).
 *
 * The same shape as the API-key routes: all of them sit behind the session
 * guard, every one is thin, and the query is parsed rather than trusted —
 * `sort`, `state` and `providerId` all reach a comparison or a filter, and an
 * unvalidated `state` would quietly match nothing.
 *
 * `POST /accounts/bulk` is registered before the `:id` routes so the literal
 * path can never be read as an account named "bulk".
 */
export function accountRoutes(deps: AppDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  // Built once in the composition root, because the job manager stores a
  // worker's imported credential through the same service — see `AppDeps`.
  const accounts = deps.accountService;
  const quota = createQuotaService({
    registry: deps.registry,
    accounts: deps.accounts,
    warmup: deps.warmup,
  });

  router.get(consolePaths.accounts, (c) => {
    const parsed = accountsQuerySchema.safeParse({
      providerId: c.req.query('providerId') ?? null,
      state: c.req.query('state') ?? null,
      q: c.req.query('q') ?? '',
      sort: c.req.query('sort') ?? null,
      direction: c.req.query('direction') ?? undefined,
      limit: c.req.query('limit') ?? undefined,
      cursor: c.req.query('cursor') ?? null,
    });
    if (!parsed.success) throw AppError.invalidRequest('The list query was not valid.');
    return c.json(accounts.list(parsed.data));
  });

  router.post(consolePaths.accounts, jsonBody(accountInputSchema), (c) =>
    c.json(accounts.create(c.req.valid('json')), 201),
  );

  router.post(consolePaths.accountsBulk, jsonBody(bulkAccountActionSchema), (c) =>
    c.json(accounts.bulk(c.req.valid('json'))),
  );

  router.patch(consolePaths.account, jsonBody(accountUpdateSchema), (c) =>
    c.json(accounts.update(c.req.param('id'), c.req.valid('json'))),
  );

  router.delete(consolePaths.account, (c) => {
    accounts.remove(c.req.param('id'));
    return c.json({ ok: true } satisfies Ok);
  });

  router.get(consolePaths.quota, (c) => c.json(quota.overview()));

  router.post(consolePaths.quotaCheck, jsonBody(quotaCheckBodySchema), (c) =>
    c.json(quota.checkIn(c.req.valid('json').providerIds)),
  );

  return router;
}
