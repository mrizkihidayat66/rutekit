import type {
  LogEntry,
  RequestLog,
  TimeWindow,
  UsageBreakdownDimension,
  UsageBreakdownRow,
  UsagePoint,
  UsageSummary,
} from '@contracts';

import { anchorMs } from '../clock.ts';
import type { Rng } from '../random.ts';

/**
 * The request log is the single source of truth for everything on the Usage and
 * Dashboard pages: the hero chart, the metric tiles and the breakdown tables are
 * all derived from this one array. Deriving rather than inventing each view
 * separately is what keeps the numbers agreeing with each other — a chart that
 * says 1.2k requests beside a table that says 800 is exactly the kind of thing
 * that makes a mock feel fake.
 */

export interface TelemetrySeeds {
  readonly accounts: readonly { id: string; providerId: string }[];
  readonly apiKeyIds: readonly string[];
  readonly models: readonly { providerId: string; model: string }[];
}

const PATHS = [
  { method: 'POST', path: '/v1/chat/completions', surface: 'chat' },
  { method: 'POST', path: '/v1/messages', surface: 'messages' },
  { method: 'POST', path: '/v1/responses', surface: 'responses' },
  { method: 'POST', path: '/v1/completions', surface: 'completions' },
  { method: 'GET', path: '/v1/models', surface: 'models' },
] as const;

const ERROR_KINDS: Readonly<Record<number, string>> = {
  400: 'invalid_request',
  401: 'authentication',
  403: 'permission',
  404: 'not_found',
  429: 'rate_limit',
  500: 'upstream_error',
  502: 'upstream_error',
  503: 'unavailable',
  504: 'timeout',
};

/** Blended USD per million tokens, sampled so costs land in a believable band. */
function priceFor(rng: Rng): number {
  return rng.weighted([
    [0.15, 34],
    [0.6, 22],
    [2.5, 20],
    [5, 12],
    [15, 8],
    [75, 4],
  ]);
}

function pickStatus(rng: Rng): number {
  return rng.weighted<number>([
    [200, 88],
    [429, 4],
    [500, 3],
    [400, 2],
    [504, 1.5],
    [401, 1],
    [503, 0.5],
  ]);
}

export function buildRequests(rng: Rng, seeds: TelemetrySeeds): RequestLog[] {
  const requests: RequestLog[] = [];
  const total = 520;
  const now = anchorMs();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;

  for (let index = 0; index < total; index += 1) {
    // Recency bias: `u^2` clusters requests toward the present, so the 1h and
    // 24h views are dense while the 30d view still has a long tail.
    const u = rng.float(0, 1);
    const ageMs = u * u * thirtyDays;
    const at = new Date(now - ageMs).toISOString();

    const endpoint = rng.weighted<(typeof PATHS)[number]>([
      [PATHS[0], 62],
      [PATHS[1], 16],
      [PATHS[2], 9],
      [PATHS[3], 5],
      [PATHS[4], 8],
    ]);
    const modelRef = rng.pick(seeds.models);
    const account = rng.pick(seeds.accounts);
    const status = pickStatus(rng);
    const failed = status >= 400;
    const streamed = endpoint.surface === 'chat' || endpoint.surface === 'messages' || endpoint.surface === 'responses';
    const isModels = endpoint.surface === 'models';

    const inputTokens = isModels ? null : rng.int(120, 14_000);
    const outputTokens = isModels ? null : failed ? rng.int(0, 120) : rng.int(40, 3_200);
    const price = priceFor(rng);
    const costUsd =
      inputTokens === null || outputTokens === null
        ? isModels
          ? 0
          : null
        : rng.round(((inputTokens + outputTokens * 3) / 1_000_000) * price, 6);
    const latencyMs = failed && status === 504 ? rng.int(30_000, 60_000) : rng.int(180, 9_400);
    const ttftMs = streamed && !failed ? rng.int(120, 2_400) : null;

    requests.push({
      id: `req_${String(index + 1).padStart(4, '0')}`,
      at,
      method: endpoint.method,
      path: endpoint.path,
      providerId: isModels ? null : modelRef.providerId,
      model: isModels ? null : modelRef.model,
      accountId: isModels ? null : account.id,
      apiKeyId: rng.pick(seeds.apiKeyIds),
      status,
      errorKind: failed ? (ERROR_KINDS[status] ?? 'internal') : null,
      latencyMs,
      ttftMs,
      inputTokens,
      outputTokens,
      costUsd,
      streamed,
      hasCapture: rng.bool(0.42),
    });
  }

  return requests.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Bucket size and count per window; chosen so every chart has 12–30 points. */
const BUCKETS: Readonly<Record<TimeWindow, { ms: number; count: number }>> = {
  '1h': { ms: 5 * 60_000, count: 12 },
  '6h': { ms: 15 * 60_000, count: 24 },
  '12h': { ms: 30 * 60_000, count: 24 },
  '24h': { ms: 60 * 60_000, count: 24 },
  '7d': { ms: 6 * 60 * 60_000, count: 28 },
  '30d': { ms: 24 * 60 * 60_000, count: 30 },
  all: { ms: 24 * 60 * 60_000, count: 90 },
};

function emptyPoint(at: string): UsagePoint {
  return { at, requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, errors: 0 };
}

export function windowStart(window: TimeWindow): number {
  const bucket = BUCKETS[window];
  return anchorMs() - bucket.ms * bucket.count;
}

/** Requests inside a window, newest first. */
export function requestsInWindow(requests: readonly RequestLog[], window: TimeWindow): RequestLog[] {
  const start = windowStart(window);
  return requests.filter((request) => Date.parse(request.at) >= start);
}

export function bucketRequests(requests: readonly RequestLog[], window: TimeWindow): UsagePoint[] {
  const bucket = BUCKETS[window];
  const start = windowStart(window);
  const points: UsagePoint[] = [];
  for (let index = 0; index < bucket.count; index += 1) {
    points.push(emptyPoint(new Date(start + index * bucket.ms).toISOString()));
  }

  for (const request of requests) {
    const at = Date.parse(request.at);
    const index = Math.floor((at - start) / bucket.ms);
    const point = points[index];
    if (point === undefined) continue;
    point.requests += 1;
    point.inputTokens += request.inputTokens ?? 0;
    point.outputTokens += request.outputTokens ?? 0;
    point.cachedInputTokens += Math.floor((request.inputTokens ?? 0) * 0.18);
    point.costUsd = Math.round((point.costUsd + (request.costUsd ?? 0)) * 1_000_000) / 1_000_000;
    if (request.status >= 400) point.errors += 1;
  }

  return points;
}

export function summarize(requests: readonly RequestLog[], window: TimeWindow): UsageSummary {
  const inWindow = requestsInWindow(requests, window);
  const succeeded = inWindow.filter((request) => request.status < 400).length;
  const sum = (pick: (request: RequestLog) => number): number =>
    inWindow.reduce((total, request) => total + pick(request), 0);
  const mean = (pick: (request: RequestLog) => number | null): number | null => {
    const values = inWindow.map(pick).filter((value): value is number => value !== null);
    if (values.length === 0) return null;
    return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
  };

  return {
    window,
    requests: inWindow.length,
    successRate: inWindow.length === 0 ? 1 : succeeded / inWindow.length,
    inputTokens: sum((request) => request.inputTokens ?? 0),
    outputTokens: sum((request) => request.outputTokens ?? 0),
    cachedInputTokens: sum((request) => Math.floor((request.inputTokens ?? 0) * 0.18)),
    costUsd: Math.round(sum((request) => request.costUsd ?? 0) * 100) / 100,
    avgTtftMs: mean((request) => request.ttftMs),
    avgLatencyMs: mean((request) => request.latencyMs),
    avgTokensPerSecond: mean((request) => {
      if (request.outputTokens === null || request.ttftMs === null || request.latencyMs <= request.ttftMs) return null;
      return request.outputTokens / ((request.latencyMs - request.ttftMs) / 1_000);
    }),
  };
}

export interface BreakdownLabels {
  provider: (id: string) => string;
  account: (id: string) => string;
  apiKey: (id: string) => string;
}

function keyFor(request: RequestLog, dimension: UsageBreakdownDimension): { key: string; label: string } | null {
  switch (dimension) {
    case 'provider':
      return request.providerId === null ? null : { key: request.providerId, label: request.providerId };
    case 'model':
      return request.model === null ? null : { key: request.model, label: request.model };
    case 'account':
      return request.accountId === null ? null : { key: request.accountId, label: request.accountId };
    case 'apiKey':
      return request.apiKeyId === null ? null : { key: request.apiKeyId, label: request.apiKeyId };
    case 'status':
      return { key: String(request.status), label: request.status < 400 ? `${request.status} OK` : `${request.status} error` };
    default:
      return null;
  }
}

export function breakdown(
  requests: readonly RequestLog[],
  window: TimeWindow,
  dimension: UsageBreakdownDimension,
  labels: BreakdownLabels,
): UsageBreakdownRow[] {
  const inWindow = requestsInWindow(requests, window);
  const buckets = new Map<string, { label: string; requests: number; tokens: number; costUsd: number }>();

  for (const request of inWindow) {
    const entry = keyFor(request, dimension);
    if (entry === null) continue;
    const bucket = buckets.get(entry.key) ?? { label: entry.label, requests: 0, tokens: 0, costUsd: 0 };
    bucket.requests += 1;
    bucket.tokens += (request.inputTokens ?? 0) + (request.outputTokens ?? 0);
    bucket.costUsd += request.costUsd ?? 0;
    buckets.set(entry.key, bucket);
  }

  const total = inWindow.length || 1;
  const label = (key: string, fallback: string): string => {
    if (dimension === 'provider') return labels.provider(key) || fallback;
    if (dimension === 'account') return labels.account(key) || fallback;
    if (dimension === 'apiKey') return labels.apiKey(key) || fallback;
    return fallback;
  };

  return [...buckets.entries()]
    .map(([key, bucket]) => ({
      key,
      label: label(key, bucket.label),
      requests: bucket.requests,
      tokens: bucket.tokens,
      costUsd: Math.round(bucket.costUsd * 100) / 100,
      share: bucket.requests / total,
    }))
    .sort((a, b) => b.requests - a.requests);
}

const LOG_TEMPLATES = [
  { level: 'info', kind: 'route', message: 'Routed request to primary provider' },
  { level: 'debug', kind: 'route', message: 'Alias resolved' },
  { level: 'debug', kind: 'route', message: 'Combo entry selected' },
  { level: 'info', kind: 'account', message: 'Account leased from pool' },
  { level: 'info', kind: 'account', message: 'Account returned to pool' },
  { level: 'warn', kind: 'account', message: 'Account entered cooldown' },
  { level: 'info', kind: 'token', message: 'Streamed completion finished' },
  { level: 'warn', kind: 'error', message: 'Upstream returned 429, retrying' },
  { level: 'error', kind: 'error', message: 'Upstream request failed' },
  { level: 'info', kind: 'system', message: 'Quota sweep completed' },
  { level: 'debug', kind: 'system', message: 'Compression applied to message history' },
] as const;

/** How many lines the seeded log holds; also the size the live tail is held at. */
export const LOG_COUNT = 460;

export function buildLogs(rng: Rng, requests: readonly RequestLog[]): LogEntry[] {
  const logs: LogEntry[] = [];
  for (let index = 0; index < LOG_COUNT; index += 1) {
    const template = rng.pick(LOG_TEMPLATES);
    const request = rng.pick(requests);
    const withRequest = rng.bool(0.7);
    logs.push({
      id: `log_${String(index + 1).padStart(4, '0')}`,
      at: new Date(anchorMs() - rng.int(0, 6 * 60) * 60_000 - rng.int(0, 59) * 1_000).toISOString(),
      level: template.level,
      kind: template.kind,
      message: template.message,
      requestId: withRequest ? request.id : null,
      providerId: withRequest ? request.providerId : null,
      accountId: withRequest ? request.accountId : null,
      fields: withRequest
        ? { model: request.model ?? '-', status: String(request.status), latency: `${request.latencyMs}ms` }
        : { instance: 'rutekit' },
    });
  }
  return logs.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/**
 * One synthetic line for the live tail.
 *
 * Deterministic in `seq`, so the sequence replays identically on a reload and a
 * test that drives the tick never sees a random line. The template rotates
 * through the catalogue, so a followed tail shows every kind and level rather
 * than one message repeated.
 */
export function buildLiveLog(seq: number, requests: readonly RequestLog[], at: string): LogEntry {
  const template = LOG_TEMPLATES[seq % LOG_TEMPLATES.length] ?? LOG_TEMPLATES[0];
  const request = requests.length === 0 ? undefined : requests[seq % requests.length];
  return {
    id: `log_live_${String(seq).padStart(4, '0')}`,
    at,
    level: template.level,
    kind: template.kind,
    message: template.message,
    requestId: request?.id ?? null,
    providerId: request?.providerId ?? null,
    accountId: request?.accountId ?? null,
    fields:
      request === undefined
        ? { instance: 'rutekit' }
        : {
            model: request.model ?? '-',
            status: String(request.status),
            latency: `${request.latencyMs}ms`,
          },
  };
}
