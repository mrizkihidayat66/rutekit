import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Ok, SearchQuery } from '@contracts';
import {
  consolePaths,
  proxyCheckBodySchema,
  proxyImportBodySchema,
  proxyInputSchema,
  proxyUpdateSchema,
  proxiesQuerySchema,
  searchQuerySchema,
  smsProviderCheckBodySchema,
  smsProviderInputSchema,
  smsProviderUpdateSchema,
  smsProvidersQuerySchema,
} from '@contracts';

import { createProxyService } from '@server/automation/proxies.ts';
import { createSmsProviderService } from '@server/automation/sms-providers.ts';
import { AppError } from '@server/errors.ts';
import { jsonBody } from '@server/ingress/validate.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The Automation section's console (C7a, FR-5.x): Proxy Pool and SMS Providers.
 *
 * The two pools the automation draws from, and nothing else yet. Jobs — the
 * worker, the stdio protocol, the manual hand-off — arrive in C7b; what is here
 * is the part that needs no browser at all, which is also the part a job depends
 * on: a bulk import cannot run without an egress to leave through, and a
 * registration cannot run without a key that rents numbers.
 *
 * Every route is behind the session guard, thin, and parses its query rather than
 * trusting it. The ordering that matters is the literal paths: `proxies/summary`
 * and `proxies/import` and `proxies/check` are all registered before
 * `proxies/:id`, because Hono matches in registration order and a parameterised
 * route declared first would read "summary" as an id. `sms-providers/summary` and
 * `sms-providers/check` sit before `sms-providers/:id` for the same reason.
 */
export function automationRoutes(deps: AppDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const proxies = createProxyService({
    proxies: deps.proxies,
    probe: deps.proxyProbe,
    secrets: deps.secrets,
    logger: deps.logger,
  });
  const sms = createSmsProviderService({
    providers: deps.smsProviders,
    checker: deps.smsChecker,
    secrets: deps.secrets,
    logger: deps.logger,
  });

  /* ---- Proxy pool ---- */

  router.get(consolePaths.proxies, (c) => {
    const parsed = proxiesQuerySchema.safeParse({
      protocol: c.req.query('protocol') ?? null,
      health: c.req.query('health') ?? null,
      ...listQueryOf(c),
    });
    if (!parsed.success) throw AppError.invalidRequest('The proxy query was not valid.');
    return c.json(proxies.list(parsed.data));
  });

  router.post(consolePaths.proxies, jsonBody(proxyInputSchema), (c) =>
    c.json(proxies.create(c.req.valid('json')), 201),
  );

  // Before `/proxies/:id`: the literal cannot be read as an id.
  router.get(consolePaths.proxiesSummary, (c) => c.json(proxies.summary()));

  router.post(consolePaths.proxiesImport, jsonBody(proxyImportBodySchema), (c) =>
    c.json(proxies.importLines(c.req.valid('json').payload)),
  );

  router.post(consolePaths.proxiesCheck, jsonBody(proxyCheckBodySchema), async (c) =>
    c.json(await proxies.check(c.req.valid('json').ids)),
  );

  router.get(consolePaths.proxy, (c) => c.json(proxies.get(c.req.param('id'))));

  router.patch(consolePaths.proxy, jsonBody(proxyUpdateSchema), (c) =>
    c.json(proxies.update(c.req.param('id'), c.req.valid('json'))),
  );

  router.delete(consolePaths.proxy, (c) => {
    proxies.remove(c.req.param('id'));
    return c.json({ ok: true } satisfies Ok);
  });

  /* ---- SMS providers ---- */

  router.get(consolePaths.smsProviders, (c) => {
    const parsed = smsProvidersQuerySchema.safeParse({
      kind: c.req.query('kind') ?? null,
      status: c.req.query('status') ?? null,
      ...listQueryOf(c),
    });
    if (!parsed.success) throw AppError.invalidRequest('The SMS provider query was not valid.');
    return c.json(sms.list(parsed.data));
  });

  router.post(consolePaths.smsProviders, jsonBody(smsProviderInputSchema), (c) =>
    c.json(sms.create(c.req.valid('json')), 201),
  );

  // Before `/sms-providers/:id`, for the same reason the proxy pair is.
  router.get(consolePaths.smsProvidersSummary, (c) => c.json(sms.summary()));

  router.post(consolePaths.smsProvidersCheck, jsonBody(smsProviderCheckBodySchema), async (c) =>
    c.json(await sms.check(c.req.valid('json').ids)),
  );

  router.get(consolePaths.smsProvider, (c) => c.json(sms.get(c.req.param('id'))));

  router.patch(consolePaths.smsProvider, jsonBody(smsProviderUpdateSchema), (c) =>
    c.json(sms.update(c.req.param('id'), c.req.valid('json'))),
  );

  router.delete(consolePaths.smsProvider, (c) => {
    sms.remove(c.req.param('id'));
    return c.json({ ok: true } satisfies Ok);
  });

  return router;
}

/**
 * The shared list query, read off the URL.
 *
 * `limit` and `direction` are left to the schema's own coercion and defaults, so
 * an absent `limit` is 50 rather than a `NaN` slice, and an unrecognised
 * `direction` is a 400 rather than silently descending.
 */
function listQueryOf(c: Context<AppEnv>): SearchQuery {
  const parsed = searchQuerySchema.safeParse({
    q: c.req.query('q') ?? '',
    sort: c.req.query('sort') ?? null,
    direction: c.req.query('direction') ?? undefined,
    limit: c.req.query('limit') ?? undefined,
    cursor: c.req.query('cursor') ?? null,
  });
  if (!parsed.success) throw AppError.invalidRequest('The list query was not valid.');
  return parsed.data;
}
