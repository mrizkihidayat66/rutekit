import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_API_PREFIX,
  consoleErrorSchema,
  consolePaths,
  dashboardSchema,
  logsResponseSchema,
  okSchema,
  requestDetailSchema,
  requestsResponseSchema,
  usageBreakdownResponseSchema,
  usageSeriesSchema,
  usageSummarySchema,
} from '@contracts';
import type { RequestLog } from '@contracts';

import { buildApp } from '@server/app.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The Overview console (C6, FR-12.1–12.4).
 *
 * Route-level over the real composition. The three read models come from three
 * different places — the pool and the process, the request table, and the log
 * ring — so what this file is really asserting is that each route reads the
 * place it claims to and returns the contract's shape.
 *
 * The rows are written straight through the repository rather than by driving
 * `/v1` turns. `v1-telemetry.test.ts` covers the writer end to end; here the
 * question is what the readers do with rows that already exist, and seeding them
 * directly is what lets a test place a request at a chosen instant — which is the
 * only way to assert a window boundary or a chart bucket.
 */

const PASSWORD = 'correct-horse-battery';

type App = ReturnType<typeof buildApp>;

async function signIn(app: App): Promise<string> {
  const response = await app.request(`${CONSOLE_API_PREFIX}${consolePaths.authSetup}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, instanceName: 'Test' }),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) throw new Error('setup did not set a session cookie');
  const pair = setCookie.split(';')[0];
  if (pair === undefined) throw new Error('empty set-cookie header');
  return pair;
}

async function call(
  app: App,
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  return app.request(path, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function errorOf(response: Response): Promise<{ kind: string; message: string }> {
  return consoleErrorSchema.parse(await response.json()).error;
}

const DASHBOARD_PATH = `${CONSOLE_API_PREFIX}${consolePaths.dashboard}`;
const USAGE_SUMMARY_PATH = `${CONSOLE_API_PREFIX}${consolePaths.usageSummary}`;
const USAGE_SERIES_PATH = `${CONSOLE_API_PREFIX}${consolePaths.usageSeries}`;
const USAGE_BREAKDOWN_PATH = `${CONSOLE_API_PREFIX}${consolePaths.usageBreakdown}`;
const REQUESTS_PATH = `${CONSOLE_API_PREFIX}${consolePaths.requests}`;
const LOGS_PATH = `${CONSOLE_API_PREFIX}${consolePaths.logs}`;
const LOW_STRESS_PATH = `${CONSOLE_API_PREFIX}${consolePaths.lowStress}`;

let server: TestServer;
let app: App;
let cookie: string;

beforeEach(async () => {
  server = makeServer();
  server.lifecycle.markReady();
  app = buildApp(server);
  cookie = await signIn(app);
});

afterEach(() => {
  server.close();
});

interface SeedOptions {
  readonly id?: string;
  readonly minutesAgo?: number;
  readonly providerId?: string | null;
  readonly model?: string | null;
  readonly apiKeyId?: string | null;
  readonly status?: number;
  readonly latencyMs?: number;
  readonly ttftMs?: number | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly costUsd?: number | null;
  readonly streamed?: boolean;
  readonly path?: string;
}

/** Write one telemetry row, placed at a chosen instant. */
function seed(options: SeedOptions = {}): string {
  const id = options.id ?? crypto.randomUUID();
  const minutesAgo = options.minutesAgo ?? 0;
  server.requests.record({
    id,
    at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    method: 'POST',
    path: options.path ?? '/v1/chat/completions',
    providerId: options.providerId === undefined ? 'openai' : options.providerId,
    model: options.model === undefined ? 'gpt-4o' : options.model,
    accountId: 'acc_1',
    apiKeyId: options.apiKeyId === undefined ? 'key_1' : options.apiKeyId,
    status: options.status ?? 200,
    errorKind: (options.status ?? 200) >= 400 ? 'upstream_error' : null,
    latencyMs: options.latencyMs ?? 500,
    ttftMs: options.ttftMs === undefined ? 120 : options.ttftMs,
    inputTokens: options.inputTokens === undefined ? 100 : options.inputTokens,
    outputTokens: options.outputTokens === undefined ? 50 : options.outputTokens,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    costUsd: options.costUsd === undefined ? 0.01 : options.costUsd,
    streamed: options.streamed ?? false,
    requestId: null,
  });
  return id;
}

describe('the session guard', () => {
  it('refuses the dashboard without a session', async () => {
    const response = await call(app, DASHBOARD_PATH);
    expect(response.status).toBe(401);
    expect((await errorOf(response)).kind).toBe('authentication');
  });
});

describe('the dashboard', () => {
  it('answers the whole contract on an empty instance', async () => {
    const response = await call(app, DASHBOARD_PATH, { cookie });

    expect(response.status).toBe(200);
    const dashboard = dashboardSchema.parse(await response.json());
    // A fresh install has nothing to report, and every card has to render an
    // empty state rather than a zero that reads as a real measurement.
    expect(dashboard.traffic).toEqual([]);
    expect(dashboard.recentErrors).toEqual([]);
    expect(dashboard.accounts.total).toBe(0);
    expect(dashboard.providers.total).toBeGreaterThan(20);
    // No provider has a credential yet, so every one of them needs auth.
    expect(dashboard.providers.needsAuth).toBe(dashboard.providers.total);
  });

  it('reports the process and database resources', async () => {
    const dashboard = dashboardSchema.parse(
      await (await call(app, DASHBOARD_PATH, { cookie })).json(),
    );

    expect(dashboard.status.resources.bunVersion).not.toBe('');
    expect(dashboard.status.resources.uptimeSeconds).toBeGreaterThanOrEqual(0);
    // An in-memory database has no file, and reporting a fabricated size would be
    // worse than reporting none.
    expect(dashboard.status.resources.diskUsedBytes).toBe(0);
    expect(dashboard.status.health.map((tile) => tile.id)).toEqual([
      'database',
      'pool',
      'websocket',
    ]);
  });

  it('counts the requests it has been given, in the traffic chart', async () => {
    seed({ minutesAgo: 5 });
    seed({ minutesAgo: 10, status: 502 });

    const dashboard = dashboardSchema.parse(
      await (await call(app, DASHBOARD_PATH, { cookie })).json(),
    );

    const requests = dashboard.traffic.reduce((sum, point) => sum + point.requests, 0);
    const errors = dashboard.traffic.reduce((sum, point) => sum + point.errors, 0);
    expect(requests).toBe(2);
    expect(errors).toBe(1);
  });

  it('lists the most recent failures for the "what broke" panel', async () => {
    seed({ minutesAgo: 1, status: 502, model: 'gpt-4o' });
    seed({ minutesAgo: 2, status: 200 });

    const dashboard = dashboardSchema.parse(
      await (await call(app, DASHBOARD_PATH, { cookie })).json(),
    );

    expect(dashboard.recentErrors).toHaveLength(1);
    expect(dashboard.recentErrors[0]?.status).toBe(502);
  });

  it('carries the key list, so the panel needs no second request', async () => {
    server.apiKeys.create({
      name: 'primary',
      modelsAllowed: [],
      modelsDenied: [],
      budgetRequests: null,
      budgetTokens: null,
      tpsLimit: null,
      rateLimitPerMinute: null,
      expiresAt: null,
      clientRouterDenylist: [],
    });

    const dashboard = dashboardSchema.parse(
      await (await call(app, DASHBOARD_PATH, { cookie })).json(),
    );

    expect(dashboard.apiKeys.map((key) => key.name)).toEqual(['primary']);
    // The secret is never in a read model (SEC-1). The display prefix is, and it
    // is meant to be — what must not be is any field that could be presented as a
    // credential.
    const fields = Object.keys(dashboard.apiKeys[0] ?? {});
    expect(fields).not.toContain('secret');
    expect(fields).not.toContain('secretHash');
  });
});

describe('low-stress mode', () => {
  it('writes the switch and reports it back on the dashboard', async () => {
    const written = await call(app, LOW_STRESS_PATH, {
      method: 'POST',
      body: { enabled: true },
      cookie,
    });
    expect(okSchema.parse(await written.json()).ok).toBe(true);

    const dashboard = dashboardSchema.parse(
      await (await call(app, DASHBOARD_PATH, { cookie })).json(),
    );
    expect(dashboard.status.lowStressMode).toBe(true);
    // The planner reads the same record, so the switch the dashboard shows and
    // the switch routing obeys cannot disagree.
    expect(server.settings.read().lowStressMode).toBe(true);
  });

  it('refuses a body that is not a boolean', async () => {
    const response = await call(app, LOW_STRESS_PATH, {
      method: 'POST',
      body: { enabled: 'yes' },
      cookie,
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).kind).toBe('invalid_request');
  });
});

describe('usage summary', () => {
  it('reports a success rate of 1 on an empty window', async () => {
    const summary = usageSummarySchema.parse(
      await (await call(app, `${USAGE_SUMMARY_PATH}?window=24h`, { cookie })).json(),
    );

    // Nothing failed, so the rate is 1 rather than 0 — a fresh install's dashboard
    // must not paint entirely red.
    expect(summary.requests).toBe(0);
    expect(summary.successRate).toBe(1);
    // No turn streamed, so there is no time to first token to average.
    expect(summary.avgTtftMs).toBeNull();
    expect(summary.avgTokensPerSecond).toBeNull();
  });

  it('totals the window and derives the rate', async () => {
    seed({ inputTokens: 100, outputTokens: 50, costUsd: 0.01, latencyMs: 1000, ttftMs: 200 });
    seed({ inputTokens: 200, outputTokens: 100, costUsd: 0.02, status: 502, latencyMs: 3000 });

    const summary = usageSummarySchema.parse(
      await (await call(app, `${USAGE_SUMMARY_PATH}?window=24h`, { cookie })).json(),
    );

    expect(summary.requests).toBe(2);
    expect(summary.successRate).toBe(0.5);
    expect(summary.inputTokens).toBe(300);
    expect(summary.outputTokens).toBe(150);
    expect(summary.costUsd).toBeCloseTo(0.03, 6);
    // Both rows have a ttft — 200 and the default 120 — so the mean is over two.
    expect(summary.avgTtftMs).toBe(160);
    expect(summary.avgLatencyMs).toBe(2000);
  });

  it('leaves the latency means null rather than zero when nothing measured', async () => {
    seed({ ttftMs: null });

    const summary = usageSummarySchema.parse(
      await (await call(app, `${USAGE_SUMMARY_PATH}?window=24h`, { cookie })).json(),
    );

    // A non-streaming turn has no first token. Reporting 0 would claim it arrived
    // instantly, which is a different fact from "nobody measured".
    expect(summary.avgTtftMs).toBeNull();
  });

  it('excludes rows outside the window', async () => {
    seed({ minutesAgo: 5 });
    seed({ minutesAgo: 60 * 30 });

    const hour = usageSummarySchema.parse(
      await (await call(app, `${USAGE_SUMMARY_PATH}?window=1h`, { cookie })).json(),
    );
    expect(hour.requests).toBe(1);

    const month = usageSummarySchema.parse(
      await (await call(app, `${USAGE_SUMMARY_PATH}?window=30d`, { cookie })).json(),
    );
    expect(month.requests).toBe(2);
  });
});

describe('usage series', () => {
  it('densifies the window, so a quiet hour is a zero rather than a gap', async () => {
    seed({ minutesAgo: 5 });

    const series = usageSeriesSchema.parse(
      await (await call(app, `${USAGE_SERIES_PATH}?window=1h`, { cookie })).json(),
    );

    // A `GROUP BY` returns only the buckets that have rows; the chart needs every
    // bucket, or a busy hour would be drawn adjacent to one six hours away.
    expect(series.points.length).toBeGreaterThan(50);
    expect(series.points.filter((point) => point.requests === 1)).toHaveLength(1);
    expect(series.points.filter((point) => point.requests === 0).length).toBe(
      series.points.length - 1,
    );
  });

  it('returns every bucket even when nothing happened', async () => {
    const series = usageSeriesSchema.parse(
      await (await call(app, `${USAGE_SERIES_PATH}?window=1h`, { cookie })).json(),
    );

    expect(series.points.length).toBeGreaterThan(50);
    expect(series.points.every((point) => point.requests === 0)).toBe(true);
  });
});

describe('usage breakdown', () => {
  it('groups by provider and computes each share', async () => {
    seed({ providerId: 'openai' });
    seed({ providerId: 'openai' });
    seed({ providerId: 'groq' });

    const breakdown = usageBreakdownResponseSchema.parse(
      await (await call(app, `${USAGE_BREAKDOWN_PATH}?window=24h&dimension=provider`, { cookie })).json(),
    );

    expect(breakdown.dimension).toBe('provider');
    expect(breakdown.rows[0]?.key).toBe('openai');
    expect(breakdown.rows[0]?.requests).toBe(2);
    // The label is the provider's own display name rather than its slug, and it is
    // never empty — a row an operator cannot name is a row they cannot act on.
    expect(breakdown.rows[0]?.label).not.toBe('');
    expect(breakdown.rows[0]?.label).not.toBe('openai');
    expect(breakdown.rows[0]?.share).toBeCloseTo(2 / 3, 6);
  });

  it('labels an unattributed row rather than keying it on null', async () => {
    seed({ providerId: null });

    const breakdown = usageBreakdownResponseSchema.parse(
      await (await call(app, `${USAGE_BREAKDOWN_PATH}?window=24h&dimension=provider`, { cookie })).json(),
    );

    expect(breakdown.rows[0]?.key).toBe('unknown');
    expect(breakdown.rows[0]?.label).toBe('Unattributed');
  });

  it('groups by status with a readable label', async () => {
    seed({ status: 200 });
    seed({ status: 429 });

    const breakdown = usageBreakdownResponseSchema.parse(
      await (await call(app, `${USAGE_BREAKDOWN_PATH}?window=24h&dimension=status`, { cookie })).json(),
    );

    const labels = breakdown.rows.map((row) => row.label).sort();
    expect(labels).toEqual(['200 OK', '429 Rate limited']);
  });

  it('refuses an unknown dimension', async () => {
    const response = await call(app, `${USAGE_BREAKDOWN_PATH}?dimension=nonsense`, { cookie });
    expect(response.status).toBe(400);
  });
});

describe('the request table', () => {
  it('lists newest first', async () => {
    seed({ minutesAgo: 10, model: 'older' });
    seed({ minutesAgo: 1, model: 'newer' });

    const page = requestsResponseSchema.parse(
      await (await call(app, `${REQUESTS_PATH}?window=24h`, { cookie })).json(),
    );

    expect(page.items.map((row) => row.model)).toEqual(['newer', 'older']);
  });

  it('filters by provider, model, key and outcome', async () => {
    seed({ providerId: 'openai', model: 'gpt-4o', apiKeyId: 'k1', status: 200 });
    seed({ providerId: 'groq', model: 'llama', apiKeyId: 'k2', status: 502 });

    const base = `${REQUESTS_PATH}?window=24h`;
    const byProvider = requestsResponseSchema.parse(
      await (await call(app, `${base}&providerId=groq`, { cookie })).json(),
    );
    expect(byProvider.items.map((row) => row.model)).toEqual(['llama']);

    const byModel = requestsResponseSchema.parse(
      await (await call(app, `${base}&model=gpt-4o`, { cookie })).json(),
    );
    expect(byModel.items).toHaveLength(1);

    const byKey = requestsResponseSchema.parse(
      await (await call(app, `${base}&apiKeyId=k2`, { cookie })).json(),
    );
    expect(byKey.items).toHaveLength(1);

    const errorsOnly = requestsResponseSchema.parse(
      await (await call(app, `${base}&outcome=errors`, { cookie })).json(),
    );
    expect(errorsOnly.items.map((row) => row.status)).toEqual([502]);

    const successOnly = requestsResponseSchema.parse(
      await (await call(app, `${base}&outcome=success`, { cookie })).json(),
    );
    expect(successOnly.items.map((row) => row.status)).toEqual([200]);
  });

  it('pages, and stops offering a cursor at the end', async () => {
    for (let index = 0; index < 3; index += 1) seed({ minutesAgo: index + 1 });

    const first = requestsResponseSchema.parse(
      await (await call(app, `${REQUESTS_PATH}?window=24h&limit=2`, { cookie })).json(),
    );
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(3);
    expect(first.nextCursor).toBe('2');

    const second = requestsResponseSchema.parse(
      await (await call(app, `${REQUESTS_PATH}?window=24h&limit=2&cursor=2`, { cookie })).json(),
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it('reports whether a capture is still live', async () => {
    seed();

    const page = requestsResponseSchema.parse(
      await (await call(app, `${REQUESTS_PATH}?window=24h`, { cookie })).json(),
    );

    expect(page.items[0]?.hasCapture).toBe(false);
  });
});

describe('the request inspector', () => {
  it('answers every stage, even the ones with nothing captured', async () => {
    const id = seed();

    const detail = requestDetailSchema.parse(
      await (await call(app, `${CONSOLE_API_PREFIX}${consolePaths.request.replace(':id', id)}`, { cookie })).json(),
    );

    expect(detail.request.id).toBe(id);
    // A missing panel would read as "this hop did not happen" rather than
    // "capture was off", so all five are always present.
    expect(detail.panels.map((panel) => panel.stage)).toEqual([
      'client_request',
      'canonical',
      'upstream_request',
      'upstream_response',
      'client_response',
    ]);
    expect(detail.panels.every((panel) => panel.body === null)).toBe(true);
  });

  it('shows a captured body with its redaction flag', async () => {
    const id = seed();
    server.requests.saveCapture({
      id: crypto.randomUUID(),
      requestId: id,
      stage: 'client_request',
      body: '{"model":"gpt-4o","api_key":"[redacted]"}',
      byteSize: 42,
      truncated: false,
      redacted: true,
      capturedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const detail = requestDetailSchema.parse(
      await (await call(app, `${CONSOLE_API_PREFIX}${consolePaths.request.replace(':id', id)}`, { cookie })).json(),
    );

    const panel = detail.panels.find((entry) => entry.stage === 'client_request');
    expect(panel?.body).toContain('[redacted]');
    expect(panel?.redacted).toBe(true);
    expect(detail.request.hasCapture).toBe(true);
  });

  it('hides a capture whose TTL has passed', async () => {
    const id = seed();
    server.requests.saveCapture({
      id: crypto.randomUUID(),
      requestId: id,
      stage: 'client_request',
      body: '{"model":"gpt-4o"}',
      byteSize: 17,
      truncated: false,
      redacted: false,
      capturedAt: new Date(Date.now() - 3_600_000).toISOString(),
      // Expired a second ago. The row is still in the table until the sweep runs,
      // so this is the read path's own guard (SEC-6).
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const detail = requestDetailSchema.parse(
      await (await call(app, `${CONSOLE_API_PREFIX}${consolePaths.request.replace(':id', id)}`, { cookie })).json(),
    );

    expect(detail.panels.every((panel) => panel.body === null)).toBe(true);
    expect(detail.request.hasCapture).toBe(false);
  });

  it('draws a waterfall with a first-token step for a stream', async () => {
    const id = seed({ streamed: true, latencyMs: 1000, ttftMs: 250 });

    const detail = requestDetailSchema.parse(
      await (await call(app, `${CONSOLE_API_PREFIX}${consolePaths.request.replace(':id', id)}`, { cookie })).json(),
    );

    expect(detail.timeline.map((step) => step.stage)).toEqual(['Request', 'First token', 'Stream']);
    expect(detail.timeline[2]?.durationMs).toBe(750);
  });

  it('answers not_found for an id that does not exist', async () => {
    const response = await call(
      app,
      `${CONSOLE_API_PREFIX}${consolePaths.request.replace(':id', 'nope')}`,
      { cookie },
    );
    expect(response.status).toBe(404);
  });
});

describe('the console log', () => {
  function appendLine(message: string, level = 30): void {
    server.logRing.append({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      level: level >= 50 ? 'error' : level >= 40 ? 'warn' : 'info',
      kind: 'system',
      message,
      requestId: null,
      providerId: null,
      accountId: null,
      fields: {},
    });
  }

  it('answers an empty ring with zeroed counts', async () => {
    const page = logsResponseSchema.parse(
      await (await call(app, LOGS_PATH, { cookie })).json(),
    );

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.counts).toEqual({ debug: 0, info: 0, warn: 0, error: 0 });
  });

  it('serves the ring newest first, with counts that add up', async () => {
    appendLine('first');
    appendLine('second');
    appendLine('bad thing', 50);

    const page = logsResponseSchema.parse(
      await (await call(app, LOGS_PATH, { cookie })).json(),
    );

    expect(page.items[0]?.message).toBe('bad thing');
    expect(page.total).toBe(3);
    expect(page.counts.error).toBe(1);
    expect(page.counts.info).toBe(2);
  });

  it('filters by level without moving the counts', async () => {
    appendLine('info line');
    appendLine('warn line', 40);

    const page = logsResponseSchema.parse(
      await (await call(app, `${LOGS_PATH}?level=warn`, { cookie })).json(),
    );

    expect(page.items.map((entry) => entry.message)).toEqual(['warn line']);
    // The counts are taken before the level filter, so the tabs still add up to
    // the "All" figure while one of them is selected.
    expect(page.counts.info).toBe(1);
    expect(page.counts.warn).toBe(1);
  });

  it('searches the message and the structured fields', async () => {
    appendLine('nothing to see');
    server.logRing.append({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      level: 'info',
      kind: 'route',
      message: 'served a turn',
      requestId: null,
      providerId: null,
      accountId: null,
      fields: { model: 'gpt-4o' },
    });

    const page = logsResponseSchema.parse(
      await (await call(app, `${LOGS_PATH}?q=gpt-4o`, { cookie })).json(),
    );

    expect(page.items.map((entry) => entry.message)).toEqual(['served a turn']);
  });

  it('refuses an unknown level rather than answering everything', async () => {
    const response = await call(app, `${LOGS_PATH}?level=critical`, { cookie });
    expect(response.status).toBe(400);
  });
});

describe('what a request log carries', () => {
  it('never carries a stack trace or a credential', async () => {
    seed();
    const page = requestsResponseSchema.parse(
      await (await call(app, `${REQUESTS_PATH}?window=24h`, { cookie })).json(),
    );

    const row: RequestLog = page.items[0]!;
    expect(JSON.stringify(row)).not.toContain('at ');
    expect(Object.keys(row)).not.toContain('credential');
  });
});
