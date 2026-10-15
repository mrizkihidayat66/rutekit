import { Hono } from 'hono';
import type { Context } from 'hono';
import type { SearchQuery } from '@contracts';
import {
  consolePaths,
  jobControlBodySchema,
  jobInputSchema,
  jobManualBodySchema,
  jobSessionBodySchema,
  jobsQuerySchema,
  searchQuerySchema,
} from '@contracts';

import { AppError } from '@server/errors.ts';
import { jsonBody } from '@server/ingress/validate.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * Automation jobs on the console (C7b, FR-5.x).
 *
 * Four routes and one POST, all thin: the manager owns the batch, the worker, the
 * deadline and the recovery, and nothing here decides anything about a job. What
 * this file is for is the boundary — parsing the query, validating the body, and
 * turning a route into a call.
 *
 * `jobs` is registered before `jobs/:id`, and `jobs/:id/control` and
 * `jobs/:id/manual` after it, because Hono matches in registration order and a
 * parameterised route declared first would read "control" as an id.
 */
export function jobRoutes(deps: AppDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const jobs = deps.jobs;

  router.get(consolePaths.jobs, (c) => {
    const parsed = jobsQuerySchema.safeParse({
      providerId: c.req.query('providerId') ?? null,
      status: c.req.query('status') ?? null,
      ...listQueryOf(c),
    });
    if (!parsed.success) throw AppError.invalidRequest('The job query was not valid.');
    return c.json(jobs.list(parsed.data));
  });

  router.post(consolePaths.jobs, jsonBody(jobInputSchema), (c) =>
    c.json(jobs.create(c.req.valid('json')), 201),
  );

  router.get(consolePaths.job, (c) => c.json(jobs.get(c.req.param('id'))));

  router.post(consolePaths.jobControl, jsonBody(jobControlBodySchema), (c) =>
    c.json(jobs.control(c.req.param('id'), c.req.valid('json').action)),
  );

  router.post(consolePaths.jobManual, jsonBody(jobManualBodySchema), (c) =>
    c.json(jobs.manual(c.req.param('id'), c.req.valid('json'))),
  );

  router.post(consolePaths.jobSession, jsonBody(jobSessionBodySchema), (c) =>
    c.json(jobs.session(c.req.param('id'), c.req.valid('json'))),
  );

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
