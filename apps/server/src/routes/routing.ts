import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Ok, SearchQuery } from '@contracts';
import {
  aliasInputSchema,
  aliasUpdateSchema,
  comboInputSchema,
  comboUpdateSchema,
  consolePaths,
  mappingInputSchema,
  mappingPreviewBodySchema,
  mappingUpdateSchema,
  searchQuerySchema,
} from '@contracts';

import { AppError } from '@server/errors.ts';
import { jsonBody } from '@server/ingress/validate.ts';
import { createAliasService } from '@server/routing/aliases.ts';
import { createComboService } from '@server/routing/combos.ts';
import { createMappingService } from '@server/routing/mappings.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The Routing section's console (FR-1.3–1.5): Combos & Routes, Model Mapping.
 *
 * The same shape as the account and API-key routes — behind the session guard,
 * thin, and every query parsed rather than trusted. What is worth saying out loud
 * is the ordering of the literal paths. `combos`, `aliases` and `mappings` each
 * have a sibling under a shared prefix, and Hono matches in registration order,
 * so `/mappings/preview` is registered before `/mappings/:id`; otherwise a
 * request for the preview would be read as a mapping with the id "preview".
 *
 * Filter Rules and Token Saver also live under the Routing nav section and are
 * not here: they are their own records with their own services. The filters are
 * C8's, served from `tools.ts`; the Token Saver is `token-saver.ts` (C14). This
 * module is the three that decide what a model name means.
 */
export function routingRoutes(deps: AppDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const combos = createComboService({ combos: deps.combos });
  const aliases = createAliasService({ aliases: deps.aliases });
  const mappings = createMappingService({ mappings: deps.mappings });

  /* ---- Combos ---- */

  router.get(consolePaths.combos, (c) => c.json(combos.list(listQuery(c))));
  router.post(consolePaths.combos, jsonBody(comboInputSchema), (c) =>
    c.json(combos.create(c.req.valid('json')), 201),
  );
  router.get(consolePaths.combo, (c) => c.json(combos.get(c.req.param('id'))));
  router.patch(consolePaths.combo, jsonBody(comboUpdateSchema), (c) =>
    c.json(combos.update(c.req.param('id'), c.req.valid('json'))),
  );
  router.delete(consolePaths.combo, (c) => {
    combos.remove(c.req.param('id'));
    return c.json({ ok: true } satisfies Ok);
  });

  /* ---- Aliases ---- */

  router.get(consolePaths.aliases, (c) => c.json(aliases.list(listQuery(c))));
  router.post(consolePaths.aliases, jsonBody(aliasInputSchema), (c) =>
    c.json(aliases.create(c.req.valid('json')), 201),
  );
  router.get(consolePaths.alias, (c) => c.json(aliases.get(c.req.param('id'))));
  router.patch(consolePaths.alias, jsonBody(aliasUpdateSchema), (c) =>
    c.json(aliases.update(c.req.param('id'), c.req.valid('json'))),
  );
  router.delete(consolePaths.alias, (c) => {
    aliases.remove(c.req.param('id'));
    return c.json({ ok: true } satisfies Ok);
  });

  /* ---- Model mapping ---- */

  router.get(consolePaths.mappings, (c) => c.json(mappings.list(listQuery(c))));
  router.post(consolePaths.mappings, jsonBody(mappingInputSchema), (c) =>
    c.json(mappings.create(c.req.valid('json')), 201),
  );
  // Before `/mappings/:id`, so the literal cannot be read as an id.
  router.post(consolePaths.mappingsPreview, jsonBody(mappingPreviewBodySchema), (c) =>
    c.json(mappings.preview(c.req.valid('json'))),
  );
  router.get(consolePaths.mapping, (c) => c.json(mappings.get(c.req.param('id'))));
  router.patch(consolePaths.mapping, jsonBody(mappingUpdateSchema), (c) =>
    c.json(mappings.update(c.req.param('id'), c.req.valid('json'))),
  );
  router.delete(consolePaths.mapping, (c) => {
    mappings.remove(c.req.param('id'));
    return c.json({ ok: true } satisfies Ok);
  });

  return router;
}

/**
 * The list query, parsed from the URL.
 *
 * `limit` and `direction` are left to the schema's own coercion and defaults, so
 * an absent `limit` is 50 rather than a `NaN` slice, and an unrecognised
 * `direction` is a 400 rather than silently descending.
 */
function listQuery(c: Context<AppEnv>): SearchQuery {
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
