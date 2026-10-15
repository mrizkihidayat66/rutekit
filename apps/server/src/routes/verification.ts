import { Hono } from 'hono';
import type { Context } from 'hono';
import type { SearchQuery } from '@contracts';
import {
  calibrationInputSchema,
  consolePaths,
  searchQuerySchema,
  verificationInputSchema,
} from '@contracts';

import { AppError } from '@server/errors.ts';
import { jsonBody } from '@server/ingress/validate.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The Model Verification console (C12, FR-10.1–10.4).
 *
 * Five routes, and the two worth naming are the ones that spend the operator's
 * quota. `POST /verifications` sends up to a couple of hundred requests to one
 * endpoint; `POST /verifications/calibrate` sends a few dozen to an endpoint the
 * operator trusts, and what it writes outlives the request. Both are POSTs that
 * answer with what they measured rather than with a queued job, because a
 * verification is bounded work — the budget is the bound — and the console's
 * launcher waits for it.
 *
 * **The baselines route is not a sub-resource of a verification.** A baseline is
 * calibrated once and read by every later verification, so it belongs to the
 * instance rather than to any one result. Its path sits beside `/verifications`
 * rather than under `/verifications/:id`, which is also why it is registered
 * before the parameterised route: `baselines` and `calibrate` would otherwise be
 * read as verification ids.
 */
export function verificationRoutes(deps: AppDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const service = deps.verifications;

  router.get(consolePaths.verifications, (c) => c.json(service.list(queryOf(c))));

  // Before `/verifications/:id`, so the two literals cannot be read as ids.
  router.get(consolePaths.verificationsBaselines, (c) => c.json(service.baselines()));

  router.post(consolePaths.verificationsCalibrate, jsonBody(calibrationInputSchema), async (c) =>
    c.json(await service.calibrate(c.req.valid('json'))),
  );

  router.post(consolePaths.verifications, jsonBody(verificationInputSchema), async (c) =>
    c.json(await service.verify(c.req.valid('json')), 201),
  );

  router.get(consolePaths.verification, (c) => c.json(service.get(c.req.param('id'))));

  return router;
}

/** The history's query, read off the URL. */
function queryOf(c: Context<AppEnv>): SearchQuery {
  const parsed = searchQuerySchema.safeParse({
    q: c.req.query('q') ?? '',
    sort: c.req.query('sort') ?? null,
    direction: c.req.query('direction') ?? undefined,
    limit: c.req.query('limit') ?? undefined,
    cursor: c.req.query('cursor') ?? null,
  });
  if (!parsed.success) throw AppError.invalidRequest('The verification query was not valid.');
  return parsed.data;
}
