import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ModelsQuery, Ok, ProvidersQuery } from '@contracts';
import {
  consolePaths,
  modelsQuerySchema,
  providerInputSchema,
  providerModelInputSchema,
  providerUpdateSchema,
  providersQuerySchema,
} from '@contracts';

import { AppError } from '@server/errors.ts';
import { jsonBody } from '@server/ingress/validate.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The Providers section (C13a, FR-2.1–2.6) and provider sign-in (C3b2).
 *
 * The catalog reads two sources as one: rutekit's curated manifests and the BYOK
 * providers an operator configured. The console does not have to know which is
 * which — except where it does, and the two places it does are `PATCH`/`DELETE`
 * on a provider and on a model, both of which the service refuses for anything
 * the operator does not own.
 *
 * Sign-in is the two routes at the bottom, and they are not the same kind of
 * thing. `POST …/oauth` is an API call the console makes: it answers with JSON,
 * and the answer is either a URL to open or the reason there is none.
 * `GET …/oauth/callback` is not an API call at all — it is where the provider
 * drops the browser — so it never answers JSON. It exchanges the code and then
 * redirects to the provider's own page in the console, carrying the outcome in
 * the query string, which is what lets a page the operator is already looking at
 * say whether the sign-in worked.
 *
 * The outcome travels in the URL rather than in a body because there is no
 * JavaScript on the other end of a redirect: the browser has just navigated, and
 * a fresh page load is the only thing that can report anything. Nothing from the
 * provider's own message is echoed into that URL — a provider's error text is
 * attacker-influenced in the general case, and a query string is a place it would
 * be reflected back — so a failure is logged and reported as `oauth=error`.
 *
 * **Registration order is load-bearing in one spot.**
 * `/providers/:id/models/fetch` is registered before
 * `/providers/:id/models/:modelId`, because Hono matches in registration order
 * and the literal would otherwise be read as a model id.
 */

/** The console page a finished sign-in returns to. Mirrors the web route table. */
const PROVIDER_PAGE = '/providers';

export function providerRoutes(deps: AppDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { providerOauth, config, logger } = deps;
  const { providerCatalog: catalog, providerService: service } = deps;

  /* ---- Provider catalog ---- */

  router.get(consolePaths.providers, (c) => c.json(catalog.list(providersQueryOf(c))));

  router.post(consolePaths.providers, jsonBody(providerInputSchema), (c) =>
    c.json(service.create(c.req.valid('json')), 201),
  );

  /* ---- Model catalog ---- */

  router.get(consolePaths.models, (c) => c.json(catalog.modelCatalog(modelsQueryOf(c))));

  /* ---- One provider ---- */

  router.get(consolePaths.provider, (c) => c.json(catalog.detail(c.req.param('id'))));

  router.patch(consolePaths.provider, jsonBody(providerUpdateSchema), (c) =>
    c.json(service.update(c.req.param('id'), c.req.valid('json'))),
  );

  router.delete(consolePaths.provider, (c) => {
    service.remove(c.req.param('id'));
    return c.json({ ok: true } satisfies Ok);
  });

  router.post(consolePaths.providerTest, async (c) => c.json(await service.test(c.req.param('id'))));

  /* ---- One provider's models ---- */

  router.get(consolePaths.providerModels, (c) =>
    c.json({ models: [...catalog.models(c.req.param('id'))] }),
  );

  router.post(consolePaths.providerModels, jsonBody(providerModelInputSchema), (c) =>
    c.json(service.createModel(c.req.param('id'), c.req.valid('json')), 201),
  );

  // Before `/providers/:id/models/:modelId`, which would read `fetch` as an id.
  router.post(consolePaths.providerModelsFetch, async (c) =>
    c.json({ models: [...(await service.fetchModels(c.req.param('id')))] }),
  );

  router.patch(consolePaths.providerModel, jsonBody(providerModelInputSchema), (c) =>
    c.json(service.updateModel(c.req.param('id'), c.req.param('modelId'), c.req.valid('json'))),
  );

  router.delete(consolePaths.providerModel, (c) => {
    service.removeModel(c.req.param('id'), c.req.param('modelId'));
    return c.json({ ok: true } satisfies Ok);
  });

  /* ---- Sign-in ---- */

  router.post(consolePaths.providerOauth, async (c) =>
    c.json(await providerOauth.start(c.req.param('id'))),
  );

  router.get(consolePaths.providerOauthCallback, async (c) => {
    const providerId = c.req.param('id');
    const destination = new URL(
      `${PROVIDER_PAGE}/${encodeURIComponent(providerId)}`,
      config.consoleOrigin,
    );

    /** Send the browser back to the console, saying only whether it worked. */
    const back = (outcome: 'ok' | 'error'): Response => {
      destination.searchParams.set('oauth', outcome);
      return c.redirect(destination.toString());
    };

    // RFC 6749 lets the provider refuse before it ever issues a code, by sending
    // `error` instead of `code`. That is an answer, not a malformed request.
    const refused = c.req.query('error');
    if (refused !== undefined) {
      logger.warn({ providerId, error: refused }, 'provider refused the sign-in');
      return back('error');
    }

    const code = c.req.query('code');
    const state = c.req.query('state');
    if (code === undefined || state === undefined) return back('error');

    const result = await providerOauth.complete(providerId, code, state);
    if (!result.ok) {
      logger.warn({ providerId, message: result.message }, 'provider sign-in did not complete');
      return back('error');
    }

    logger.info({ providerId, accountId: result.value.id }, 'provider signed in');
    return back('ok');
  });

  return router;
}

/** The catalog's query, read off the URL. */
function providersQueryOf(c: Context<AppEnv>): ProvidersQuery {
  const parsed = providersQuerySchema.safeParse({
    q: c.req.query('q') ?? '',
    sort: c.req.query('sort') ?? null,
    direction: c.req.query('direction') ?? undefined,
    limit: c.req.query('limit') ?? undefined,
    cursor: c.req.query('cursor') ?? null,
    category: c.req.query('category') ?? null,
    status: c.req.query('status') ?? null,
    tier: c.req.query('tier') ?? undefined,
  });
  if (!parsed.success) throw AppError.invalidRequest('The provider query was not valid.');
  return parsed.data;
}

/** The model catalog's query, read off the URL. */
function modelsQueryOf(c: Context<AppEnv>): ModelsQuery {
  const parsed = modelsQuerySchema.safeParse({
    q: c.req.query('q') ?? '',
    sort: c.req.query('sort') ?? null,
    direction: c.req.query('direction') ?? undefined,
    limit: c.req.query('limit') ?? undefined,
    cursor: c.req.query('cursor') ?? null,
    providerId: c.req.query('providerId') ?? null,
    capability: c.req.query('capability') ?? null,
    source: c.req.query('source') ?? null,
    minContext: c.req.query('minContext') ?? null,
  });
  if (!parsed.success) throw AppError.invalidRequest('The model query was not valid.');
  return parsed.data;
}
