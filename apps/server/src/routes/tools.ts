import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Ok, SearchQuery } from '@contracts';
import {
  consolePaths,
  dotTrickBodySchema,
  filterRuleInputSchema,
  filterRuleUpdateSchema,
  searchQuerySchema,
  vccCardUpdateSchema,
  vccCardsQuerySchema,
  vccGenerateBodySchema,
} from '@contracts';

import { AppError } from '@server/errors.ts';
import { jsonBody } from '@server/ingress/validate.ts';
import { createFilterRuleService } from '@server/tools/filter-service.ts';
import { expandEmail } from '@server/tools/dot-trick.ts';
import { createVccService } from '@server/tools/vcc.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The Tools section's console (C8, FR-11.1–11.3).
 *
 * Three things an operator runs by hand rather than things the router does:
 * expanding an address, minting cards, and writing the rules that rewrite or
 * refuse a request. The first two are here; the rules' *engine* is in
 * `tools/filters.ts` and runs inside the data plane, which is the only place a
 * request passes through.
 *
 * The ordering that matters is the literals. `vcc/bins` and `vcc/generate` are
 * registered before `vcc/:id`, and `vcc/:id/reveal` after — Hono matches in
 * registration order, so a parameterised route declared first would read "bins"
 * as a card id and "generate" as one too.
 */
export function toolsRoutes(deps: AppDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const vcc = createVccService({
    cards: deps.vccCards,
    secrets: deps.secrets,
    random: deps.random ?? ((bytes) => crypto.getRandomValues(new Uint8Array(bytes))),
  });
  const filters = createFilterRuleService({ rules: deps.filterRules });

  /* ---- Dot trick ---- */

  router.post(consolePaths.dotTrick, jsonBody(dotTrickBodySchema), (c) => {
    const body = c.req.valid('json');
    // Pure arithmetic with no state to keep, so there is nothing to store and no
    // second read of it — the answer is the response.
    return c.json(expandEmail(body.email, { mode: body.mode, limit: body.limit }));
  });

  /* ---- VCC pool ---- */

  router.get(consolePaths.vccCards, (c) => {
    const parsed = vccCardsQuerySchema.safeParse({
      brand: c.req.query('brand') ?? null,
      status: c.req.query('status') ?? null,
      ...listQueryOf(c),
    });
    if (!parsed.success) throw AppError.invalidRequest('The card query was not valid.');
    return c.json(vcc.list(parsed.data));
  });

  // Before `/tools/vcc/:id`, so the literal cannot be read as a card id.
  router.get(consolePaths.vccBins, (c) => c.json({ bins: [...vcc.bins()] }));

  router.post(consolePaths.vccGenerate, jsonBody(vccGenerateBodySchema), (c) =>
    c.json(vcc.generate(c.req.valid('json')), 201),
  );

  router.get(consolePaths.vccCard, (c) => c.json(vcc.get(c.req.param('id'))));

  /**
   * The one place a full number leaves rutekit (FR-11.2).
   *
   * A GET because it reads and changes nothing, and its own path rather than a
   * field on the card so the read model never carries a PAN and the decision to
   * show one is a request about one card at a time.
   */
  router.get(consolePaths.vccReveal, (c) => c.json(vcc.reveal(c.req.param('id'))));

  router.patch(consolePaths.vccCard, jsonBody(vccCardUpdateSchema), (c) =>
    c.json(vcc.update(c.req.param('id'), c.req.valid('json'))),
  );

  router.delete(consolePaths.vccCard, (c) => {
    vcc.remove(c.req.param('id'));
    return c.json({ ok: true } satisfies Ok);
  });

  /* ---- Content filters ---- */

  router.get(consolePaths.filterRules, (c) => c.json(filters.list(listQueryOf(c))));

  router.post(consolePaths.filterRules, jsonBody(filterRuleInputSchema), (c) =>
    c.json(filters.create(c.req.valid('json')), 201),
  );

  router.get(consolePaths.filterRule, (c) => c.json(filters.get(c.req.param('id'))));

  router.patch(consolePaths.filterRule, jsonBody(filterRuleUpdateSchema), (c) =>
    c.json(filters.update(c.req.param('id'), c.req.valid('json'))),
  );

  router.delete(consolePaths.filterRule, (c) => {
    filters.remove(c.req.param('id'));
    return c.json({ ok: true } satisfies Ok);
  });

  return router;
}

/** The shared list query, read off the URL. */
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
