import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Ok, RequestsQuery } from '@contracts';
import {
  consolePaths,
  logsQuerySchema,
  lowStressBodySchema,
  requestPayloadPanelSchema,
  requestsQuerySchema,
  usageBreakdownQuerySchema,
  usageQuerySchema,
  usageSeriesQuerySchema,
  type RequestPayloadPanel,
  type RouteTraceStep,
} from '@contracts';

import { AppError } from '@server/errors.ts';
import { jsonBody } from '@server/ingress/validate.ts';
import { createDashboardService } from '@server/telemetry/dashboard.ts';
import { toRequestLog } from '@server/telemetry/usage.ts';
import { windowRange } from '@server/telemetry/window.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The Overview section's console (FR-12.1–12.4): Dashboard, Usage & Metrics,
 * Console Log.
 *
 * The same shape as every other console module — behind the session guard, thin,
 * and every query parsed rather than trusted. What is worth naming is where each
 * answer comes from, because they are three different places:
 *
 *   - the **dashboard** reads the pool, the process and the request table, and
 *     assembles them in `telemetry/dashboard.ts`;
 *   - **usage** is aggregated from the request table on every read, so a chart
 *     cannot say anything the table does not (see `persistence/requests.ts`);
 *   - the **console log** comes from the in-memory ring, which is a copy of what
 *     the process already logged.
 *
 * `/logs` is registered before nothing else here, but the two literal paths that
 * matter are the ones under `/usage` and `/requests`: `usage/summary`,
 * `usage/series` and `usage/breakdown` are siblings with no `:id` route to
 * collide with, and the request detail is `/requests/:id` against `/requests`.
 */

/** How many requests the table shows per page when the caller names no limit. */
const DEFAULT_REQUEST_LIMIT = 50;

/** The five inspector panels, in the order the drawer shows them. */
const PANEL_LABELS = {
  client_request: 'Client request',
  canonical: 'Canonical pivot',
  upstream_request: 'Upstream request',
  upstream_response: 'Upstream response',
  client_response: 'Client response',
} as const;

export function overviewRoutes(deps: AppDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const dashboard = createDashboardService({
    registry: deps.registry,
    accounts: deps.accounts,
    pool: deps.pool,
    apiKeys: deps.apiKeys,
    requests: deps.requests,
    lifecycle: deps.lifecycle,
    settings: deps.settings,
    logger: deps.logger,
    ping: () => deps.persistence.ping(),
    connections: () => deps.hub.connectionCount,
    databasePath: deps.persistence.isMemory ? null : deps.config.databaseUrl,
  });

  router.get(consolePaths.dashboard, (c) => c.json(dashboard.read()));

  router.post(consolePaths.lowStress, jsonBody(lowStressBodySchema), (c) => {
    // The planner reads this per turn, so the switch takes effect on the next
    // request rather than the next restart.
    deps.settings.write({ lowStressMode: c.req.valid('json').enabled });
    return c.json({ ok: true } satisfies Ok);
  });

  router.get(consolePaths.usageSummary, (c) => {
    const parsed = usageQuerySchema.safeParse({ window: c.req.query('window') ?? undefined });
    if (!parsed.success) throw AppError.invalidRequest('The window was not valid.');
    return c.json(deps.usage.summary(parsed.data.window));
  });

  router.get(consolePaths.usageSeries, (c) => {
    // `metrics` is accepted and ignored: the contract lets a caller pick which
    // counters to draw, and the series carries all of them so the toggle is a
    // client-side decision rather than a second request per metric.
    const parsed = usageSeriesQuerySchema.safeParse({
      window: c.req.query('window') ?? undefined,
    });
    if (!parsed.success) throw AppError.invalidRequest('The window was not valid.');
    return c.json(deps.usage.series(parsed.data.window));
  });

  router.get(consolePaths.usageBreakdown, (c) => {
    const parsed = usageBreakdownQuerySchema.safeParse({
      window: c.req.query('window') ?? undefined,
      dimension: c.req.query('dimension') ?? undefined,
    });
    if (!parsed.success) throw AppError.invalidRequest('The breakdown query was not valid.');
    return c.json(deps.usage.breakdown(parsed.data.window, parsed.data.dimension));
  });

  router.get(consolePaths.requests, (c) => c.json(listRequests(deps, c)));

  router.get(consolePaths.request, (c) => {
    const row = deps.requests.findById(c.req.param('id'));
    if (row === null) throw AppError.notFound(`No request with id ${c.req.param('id')}.`);

    const at = new Date().toISOString();
    const captures = deps.requests.capturesFor(row.id, at);
    const byStage = new Map(captures.map((capture) => [capture.stage, capture]));

    // Every stage gets a panel even when nothing was captured, because the
    // drawer's whole point is to show where a request went — a missing panel
    // reads as "this hop did not happen" rather than "capture was off".
    const panels: RequestPayloadPanel[] = Object.entries(PANEL_LABELS).map(([stage, label]) => {
      const capture = byStage.get(stage);
      const parsed = requestPayloadPanelSchema.shape.stage.safeParse(stage);
      return {
        stage: parsed.success ? parsed.data : 'client_request',
        label,
        body: capture?.body ?? null,
        byteSize: capture?.byteSize ?? null,
        truncated: capture?.truncated ?? false,
        redacted: capture?.redacted ?? false,
      };
    });

    return c.json({
      request: toRequestLog(row, captures.length > 0),
      panels,
      // The trace is derived from the row rather than stored: which hop ran is
      // already visible in the columns, and a stored trace would be a second
      // thing to keep in step with the routing it describes.
      routeTrace: routeTrace(row.model, row.providerId),
      timeline: timeline(row.latencyMs, row.ttftMs),
    });
  });

  router.get(consolePaths.logs, (c) => {
    const parsed = logsQuerySchema.safeParse({
      level: c.req.query('level') ?? null,
      kind: c.req.query('kind') ?? null,
      requestId: c.req.query('requestId') ?? null,
      q: c.req.query('q') ?? '',
      sort: c.req.query('sort') ?? null,
      direction: c.req.query('direction') ?? undefined,
      limit: c.req.query('limit') ?? undefined,
      cursor: c.req.query('cursor') ?? null,
    });
    if (!parsed.success) throw AppError.invalidRequest('The log query was not valid.');
    return c.json(deps.logRing.list(parsed.data));
  });

  return router;
}

function listRequests(deps: AppDeps, c: Context<AppEnv>) {
  const parsed = requestsQuerySchema.safeParse({
    window: c.req.query('window') ?? undefined,
    providerId: c.req.query('providerId') ?? null,
    model: c.req.query('model') ?? null,
    apiKeyId: c.req.query('apiKeyId') ?? null,
    outcome: c.req.query('outcome') ?? undefined,
    sort: c.req.query('sort') ?? null,
    direction: c.req.query('direction') ?? undefined,
    limit: c.req.query('limit') ?? undefined,
    cursor: c.req.query('cursor') ?? null,
  });
  if (!parsed.success) throw AppError.invalidRequest('The request query was not valid.');

  const query: RequestsQuery = parsed.data;
  const range = windowRange(query.window, new Date());
  const filters = {
    providerId: query.providerId,
    model: query.model,
    apiKeyId: query.apiKeyId,
    outcome: query.outcome,
  };

  const total = deps.requests.countBetween(range.from, range.to, filters);
  const offset = offsetOf(query.cursor);
  // One row past the page, so `nextCursor` is known without a second count: if
  // the repository returned exactly `limit` rows there is nothing more to ask
  // for, and asking again would be a request that always comes back empty.
  const limit = query.limit === 0 ? DEFAULT_REQUEST_LIMIT : query.limit;
  const rows = deps.requests.listBetween(range.from, range.to, filters, limit + 1, offset);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const captured = deps.requests.capturedRequestIds(
    page.map((row) => row.id),
    new Date().toISOString(),
  );

  return {
    items: page.map((row) => toRequestLog(row, captured.has(row.id))),
    nextCursor: hasMore ? String(offset + limit) : null,
    total,
  };
}

/** Cursors are plain offsets, matching what the console's pager already sends. */
function offsetOf(cursor: string | null): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}


/**
 * The routing hops a request went through.
 *
 * Only the two the row can prove are listed — which model was asked for and which
 * provider served it — plus the key's own scope check. Aliases, combos and
 * mappings are not recorded per request, so naming them here would be a guess
 * dressed as a trace; the planner's decisions are visible on the Routing pages
 * and in the console log instead.
 */
function routeTrace(model: string | null, providerId: string | null): RouteTraceStep[] {
  const trace: RouteTraceStep[] = [];
  if (model !== null) trace.push({ kind: 'alias', label: model, detail: null });
  if (providerId !== null) trace.push({ kind: 'account', label: providerId, detail: null });
  return trace;
}

/** The inspector's waterfall: the request, then the answer. */
function timeline(latencyMs: number, ttftMs: number | null): { stage: string; atMs: number; durationMs: number }[] {
  if (ttftMs === null) {
    return [
      { stage: 'Request', atMs: 0, durationMs: 0 },
      { stage: 'Answer', atMs: 0, durationMs: latencyMs },
    ];
  }
  return [
    { stage: 'Request', atMs: 0, durationMs: 0 },
    { stage: 'First token', atMs: ttftMs, durationMs: 0 },
    { stage: 'Stream', atMs: ttftMs, durationMs: Math.max(0, latencyMs - ttftMs) },
  ];
}
