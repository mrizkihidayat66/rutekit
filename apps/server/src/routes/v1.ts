import { Hono } from 'hono';
import type { Context } from 'hono';
import type { ClientSurface } from '@translator';

import { AppError } from '@server/errors.ts';
import { createDispatcher } from '@server/providers/dispatcher.ts';
import { createFilterRuleService } from '@server/tools/filter-service.ts';
import type { FilterRuleLike } from '@server/tools/filters.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The data plane (FR-1, ADR-0003).
 *
 * Five routes, and each is one line of translation around the dispatcher: the
 * path says which dialect the caller is speaking, the body is handed over as
 * JSON, and the dispatcher's `Response` is returned untouched. Nothing here
 * decides anything about a provider — that is the dispatcher's, and it is the
 * only place the two namespaces could ever disagree about an answer.
 *
 * The router is mounted under `/v1` and the API-key guard runs before it, so by
 * the time a handler here is reached the caller is authenticated and its id is on
 * the context. The row is read back rather than carried: the guard holds an id,
 * and the dispatcher needs the key's own model lists, which only the row has.
 *
 * The surface is a literal at each route rather than a lookup keyed on the path,
 * because the four paths are four different shapes and the router already knows
 * which one it is routing.
 */

export function v1Routes(deps: AppDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const dispatcher = createDispatcher({
    planner: deps.planner,
    pool: deps.pool,
    apiKeys: deps.apiKeys,
    fetch: deps.fetch,
    tokenSaver: deps.tokenSaver,
    telemetry: deps.telemetry,
    filters: () => activeFilters(deps),
    config: deps.config,
    logger: deps.logger,
  });

  router.get('/models', (c) => c.json(deps.modelListing.list()));

  router.post('/chat/completions', (c) => complete(c, 'chat-completions'));
  router.post('/messages', (c) => complete(c, 'messages'));
  router.post('/responses', (c) => complete(c, 'responses'));
  router.post('/completions', (c) => complete(c, 'completions'));

  async function complete(c: Context<AppEnv>, surface: ClientSurface): Promise<Response> {
    const id = c.get('apiKeyId');
    const apiKey = id === undefined ? null : deps.apiKeys.findById(id);
    if (apiKey === null) {
      // The guard put an id on the context, so a miss here means the key was
      // removed between the guard and this line — a race, and one the caller sees
      // as a credential problem rather than a server fault.
      throw AppError.authentication('That API key is no longer valid.');
    }

    const requestId = c.get('requestId');
    return dispatcher.complete({
      surface,
      body: await readJson(c),
      apiKey,
      requestId: typeof requestId === 'string' && requestId !== '' ? requestId : null,
    });
  }

  return router;
}

/**
 * The content filter rules, as the pipeline reads them (FR-11.3).
 *
 * Read per turn rather than captured at boot, so a rule an operator saves on the
 * console is in force on the next request — the same rule the pool's strategy and
 * the low-stress switch follow. The mapping is the console's contract into the
 * engine's narrower shape, which is what keeps the engine from depending on
 * columns it never reads.
 */
function activeFilters(deps: AppDeps): readonly FilterRuleLike[] {
  return createFilterRuleService({ rules: deps.filterRules }).active();
}

/**
 * The request body as JSON.
 *
 * Parsed here rather than by a `zValidator`, because there is no schema to give
 * one: the four surfaces have four shapes and the codec that understands a
 * surface's shape is the one that validates it, inside `ingestRequest`. This
 * route only has to get from bytes to a value, and a body that is not JSON at all
 * is the one failure it can name.
 */
async function readJson(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw AppError.invalidRequest('The request body must be JSON.');
  }
}
