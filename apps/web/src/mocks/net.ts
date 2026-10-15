import {
  HttpResponse,
  delay,
  http as mswHttp,
  type DefaultBodyType,
  type HttpRequestHandler,
  type JsonBodyType,
  type PathParams,
} from 'msw';

import { mockLatency, mockMode } from './latency.ts';

/**
 * The `http` the console handlers import instead of MSW's own.
 *
 * It is the same API, wrapped once so the scenario switch in `latency.ts` and
 * the simulated round-trip apply to every route without each handler having to
 * remember them. A handler stays a plain "parse, mutate, respond"; the timing
 * and the failure injection live here, in one place, which is also what keeps
 * the behaviour uniform across sixty routes.
 *
 * The wrapper is inert until `activateScenarios` runs, and only the browser
 * worker calls it. In a test the raw resolver runs, so a suite is deterministic
 * regardless of which mode the dev flipper was last left on — and no suite pays
 * the simulated latency sixty times over.
 */

let scenarioActive = false;

/** Turn on latency, failure injection and empty-page rewriting. Browser only. */
export function activateScenarios(): void {
  scenarioActive = true;
}

/**
 * Whether the scenario wrapper is running. A handler that would otherwise mutate
 * the database as a side effect of being read — the live log tail — gates on
 * this so a test that drives the raw resolver stays deterministic.
 */
export function scenariosActive(): boolean {
  return scenarioActive;
}

/** How the wrapper calls a resolver: it only ever reads `request` and `params`. */
type ScenarioResolver = (info: {
  request: Request;
  params: PathParams;
}) => Promise<Response | undefined | void>;

function injectFailure(): HttpResponse<JsonBodyType> {
  return HttpResponse.json(
    {
      error: {
        kind: 'internal',
        message: 'Injected mock failure — clear it from the dev flipper (?mock=normal).',
        provider: null,
        retryAfterSeconds: null,
        requestId: null,
      },
    },
    { status: 503 },
  );
}

/**
 * Rewrite a body to its empty form, leaving shapes it does not recognise alone.
 *
 * A list becomes an empty page. The shapes that carry no `items` are handled
 * explicitly, because they are the ones whose emptiness is not a missing list:
 * the dashboard, whose empty form is a fresh instance — nothing configured and
 * no traffic — and the usage page's series, breakdown and summary, which would
 * otherwise keep answering with the previous window's traffic while the request
 * table below them went blank. `?mock=empty` has to mean the same thing on every
 * page, or a page cannot be walked through its four states at all.
 */
async function emptied(response: Response): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return response;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (body === null || typeof body !== 'object') return response;

  const record = body as Record<string, unknown>;
  if (Array.isArray(record.items)) {
    const empty: Record<string, unknown> = { ...record, items: [], total: 0, nextCursor: null };
    // The console log ships per-level totals beside its page; an empty log has
    // none of any level, or the tabs would claim lines the list does not have.
    if (typeof record.counts === 'object' && record.counts !== null && !Array.isArray(record.counts)) {
      empty.counts = Object.fromEntries(Object.keys(record.counts).map((level) => [level, 0]));
    }
    return HttpResponse.json(empty);
  }
  if (Array.isArray(record.points)) {
    return HttpResponse.json({ ...record, points: [] });
  }
  if (Array.isArray(record.rows)) {
    return HttpResponse.json({ ...record, rows: [] });
  }
  if (typeof record.requests === 'number' && typeof record.successRate === 'number') {
    // Every counter zero and no averages to report. `successRate` stays 1 — a
    // fresh instance has not failed anything, and the tile reads it as "No
    // failures" rather than the alarming "0% success" a literal zero would give.
    return HttpResponse.json({
      ...record,
      requests: 0,
      successRate: 1,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
      avgTtftMs: null,
      avgLatencyMs: null,
      avgTokensPerSecond: null,
    });
  }
  if (
    typeof record.provider === 'object' &&
    record.provider !== null &&
    Array.isArray(record.models) &&
    Array.isArray(record.accounts)
  ) {
    // A provider detail page: the provider itself stays — the page is about that
    // one thing, and a blank name would be a broken page rather than an empty
    // one — but everything discovered about it is gone, so its tables and the
    // credit pool each fall back to their own empty state. The provider's own
    // counts go with them, or the credential notice would claim a rotation the
    // table below it no longer has.
    const provider = record.provider as Record<string, unknown>;
    return HttpResponse.json({
      ...record,
      provider: { ...provider, accountCount: 0, activeAccountCount: 0 },
      models: [],
      accounts: [],
      creditPools: [],
    });
  }
  if (Array.isArray(record.traffic) && typeof record.status === 'object' && record.status !== null) {
    return HttpResponse.json({
      ...record,
      traffic: [],
      providers: { total: 0, ready: 0, needsAuth: 0, error: 0, disabled: 0 },
      accounts: { total: 0, active: 0, inFlight: 0, cooldown: 0, unhealthy: 0 },
      recentErrors: [],
      quotaPools: [],
      apiKeys: [],
      status: { ...(record.status as Record<string, unknown>), health: [], endpoints: [] },
    });
  }
  return response;
}

function wrap(verb: keyof typeof mswHttp): HttpRequestHandler {
  const base = mswHttp[verb];
  return (path, resolver, options) =>
    base<PathParams, DefaultBodyType, DefaultBodyType>(
      path,
      async (info) => {
        // `resolver` arrives generic over the request body type; the console only
        // ever reads `request` and `params`, so narrowing it here is safe.
        const call = resolver as unknown as ScenarioResolver;

        if (!scenarioActive) return call(info);

        const mode = mockMode();
        if (mode === 'error') return injectFailure();

        const wait = mockLatency(mode);
        if (wait === null) await new Promise<never>(() => {});
        else if (wait > 0) await delay(wait);

        const response = await call(info);
        if (mode === 'empty' && response instanceof Response) return emptied(response);
        return response;
      },
      options,
    );
}

export const http = {
  all: wrap('all'),
  head: wrap('head'),
  get: wrap('get'),
  post: wrap('post'),
  put: wrap('put'),
  delete: wrap('delete'),
  patch: wrap('patch'),
  options: wrap('options'),
};
