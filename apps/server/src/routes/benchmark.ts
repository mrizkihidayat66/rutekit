import { Hono } from 'hono';
import type { Context } from 'hono';
import type { SearchQuery } from '@contracts';
import { benchmarkInputSchema, consolePaths, searchQuerySchema } from '@contracts';

import { AppError } from '@server/errors.ts';
import { jsonBody } from '@server/ingress/validate.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The Benchmark console (C11, FR-9.1–9.4).
 *
 * Three routes, and the interesting one is the POST. It answers `201` with the
 * run `queued` — not with results, because there are none: a benchmark is minutes
 * of work across a matrix of cells, and a request that waited for it would be a
 * request that timed out. The console watches the run instead, exactly as it
 * watches a Studio render.
 *
 * There is no cancel route and no export route. Export is done on the page, from
 * the run it already has in hand — `benchmark.ts` there already turns a run into
 * CSV and JSON, and a server-side copy would be a second rendering of the same
 * matrix that could disagree with the one the operator sees. Cancel is the honest
 * omission: promptfoo is a child process, and stopping one mid-matrix is a
 * feature to build rather than a route to stub.
 */
export function benchmarkRoutes(deps: AppDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { benchmarkCatalog: catalog, benchmarkRunner: runner } = deps;

  router.get(consolePaths.benchmarks, (c) => c.json(catalog.list(queryOf(c))));

  router.post(consolePaths.benchmarks, jsonBody(benchmarkInputSchema), (c) =>
    c.json(runner.start(c.req.valid('json')), 201),
  );

  router.get(consolePaths.benchmark, (c) => c.json(catalog.get(c.req.param('id'))));

  return router;
}

/** The run list's query, read off the URL. */
function queryOf(c: Context<AppEnv>): SearchQuery {
  const parsed = searchQuerySchema.safeParse({
    q: c.req.query('q') ?? '',
    sort: c.req.query('sort') ?? null,
    direction: c.req.query('direction') ?? undefined,
    limit: c.req.query('limit') ?? undefined,
    cursor: c.req.query('cursor') ?? null,
  });
  if (!parsed.success) throw AppError.invalidRequest('The benchmark query was not valid.');
  return parsed.data;
}
