import { afterEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_API_PREFIX,
  benchmarkRunSchema,
  benchmarksResponseSchema,
  consoleErrorSchema,
  consolePaths,
} from '@contracts';
import type { BenchmarkRun } from '@contracts';

import { buildApp } from '@server/app.ts';
import type { BenchmarkEngine, EngineRequest } from '@server/benchmark/engine.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The Benchmark console, end to end (C11, FR-9.1–9.4).
 *
 * A real composition with only the engine replaced: the session guard, the
 * benchmark routes, the runner, the API-key service it mints and revokes through,
 * and the SQLite rows behind all of it. What these assert is what an operator can
 * observe — a run appearing, its cells landing, the key being given back — and the
 * one thing that is genuinely the runner's own: **the key's lifetime.**
 *
 * The engine is a seam because the real one spawns promptfoo, which is minutes of
 * work and a real child process. What a fake engine lets these assert is that
 * rutekit's half is right: the config it would send, the parsing of what comes
 * back, and the credential it hands over and takes back.
 */

const PASSWORD = 'correct-horse-battery';

type App = ReturnType<typeof buildApp>;

const servers: TestServer[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
});

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

/** An engine a test steers: it records the request and answers with what it is told. */
interface FakeEngine extends BenchmarkEngine {
  readonly requests: EngineRequest[];
  /** The key the child was given, so a test can assert it was revoked. */
  readonly keys: string[];
}

function fakeEngine(answer: (request: EngineRequest) => unknown): FakeEngine {
  const requests: EngineRequest[] = [];
  const keys: string[] = [];
  return {
    requests,
    keys,
    run(request: EngineRequest): Promise<{ output: unknown; exitCode: number | null; stderr: string }> {
      requests.push(request);
      keys.push(request.apiKey);
      return Promise.resolve({ output: answer(request), exitCode: 0, stderr: '' });
    },
  };
}

/** A `results.json` as promptfoo writes it, for the cells the config asked for. */
function resultsFor(
  request: EngineRequest,
  perCell: (variantId: string, targetLabel: string) => Record<string, unknown>,
): unknown {
  const prompts = (request.document['prompts'] ?? []) as { label: string }[];
  const providers = (request.document['providers'] ?? []) as { label: string }[];
  const rows: unknown[] = [];
  for (const prompt of prompts) {
    for (const provider of providers) {
      // A per-cell override may replace the response's *contents* without
      // dropping the response itself: promptfoo's shape has the output, the
      // timings and any failure all inside one object, and a test that wants to
      // make a call fail has to be able to add an error to it rather than
      // replace it.
      const { response: responsePatch, ...rest } = perCell(prompt.label, provider.label);
      rows.push({
        prompt: { label: prompt.label },
        provider: { label: provider.label },
        success: true,
        response: {
          output: 'an answer',
          latencyMs: 800,
          cost: 0.0003,
          metadata: { ttftMs: 190, outputTokens: 30, tokensPerSecond: 50 },
          tokenUsage: { completion: 30 },
          // Merged rather than replaced, so a test can make a call fail without
          // also erasing the figures promptfoo would have reported beside it.
          ...(responsePatch as Record<string, unknown> | undefined),
        },
        gradingResult: { score: 1 },
        ...rest,
      });
    }
  }
  return { evalId: 'eval-1', results: { version: 3, results: rows } };
}

interface Harness {
  readonly server: TestServer;
  readonly app: App;
  readonly cookie: string;
  readonly engine: FakeEngine;
}

async function harness(engine: FakeEngine): Promise<Harness> {
  const server = makeServer({ benchmarkEngine: engine });
  server.lifecycle.markReady();
  servers.push(server);
  const app = buildApp(server);
  return { server, app, cookie: await signIn(app), engine };
}

const RUNS = `${CONSOLE_API_PREFIX}${consolePaths.benchmarks}`;
const runPath = (id: string): string =>
  `${CONSOLE_API_PREFIX}${consolePaths.benchmark.replace(':id', id)}`;

async function errorOf(response: Response): Promise<{ kind: string; message: string }> {
  return consoleErrorSchema.parse(await response.json()).error;
}

const INPUT = {
  name: 'Summarisation matrix',
  template: 'Summarise {{doc}} in {{words}} words.',
  variants: [
    { label: 'Contract, 40', prompt: 'Summarise the contract in 40 words.', variables: {} },
    { label: 'Report, 25', prompt: 'Summarise the report in 25 words.', variables: {} },
  ],
  targets: [
    { providerId: 'openai', model: 'gpt-4o-mini' },
    { providerId: 'anthropic', model: 'claude-3-opus-20240229' },
  ],
  systemPrompt: 'Be brief.',
  rubric: [{ kind: 'contains', value: 'summar' }],
} as const;

/** Poll a run until it reaches a state it will not leave. */
async function settled(h: Harness, id: string, timeoutMs = 3_000): Promise<BenchmarkRun> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = benchmarkRunSchema.parse(
      await (await call(h.app, runPath(id), { cookie: h.cookie })).json(),
    );
    if (run.status !== 'queued' && run.status !== 'running') return run;
    if (Date.now() > deadline) throw new Error(`run ${id} never settled: ${run.status}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/* ---- Starting a run ---- */

describe('starting a run', () => {
  it('answers 201 with the run queued, and fills the matrix in behind it', async () => {
    const engine = fakeEngine((request) => resultsFor(request, () => ({})));
    const h = await harness(engine);

    const response = await call(h.app, RUNS, { method: 'POST', cookie: h.cookie, body: INPUT });

    // The reply is the queue's contents, not the result: a benchmark is minutes
    // of work and a request that waited for it would time out.
    expect(response.status).toBe(201);
    const created = benchmarkRunSchema.parse(await response.json());
    expect(created.status).toBe('queued');
    expect(created.results).toEqual([]);
    expect(created.expectedResultCount).toBe(4);

    const done = await settled(h, created.id);
    expect(done.status).toBe('succeeded');
    expect(done.results).toHaveLength(4);
    expect(done.results.every((cell) => cell.status === 'succeeded')).toBe(true);
  });

  it('carries the two durations as two separate figures', async () => {
    // The reason the thin provider exists (ADR-0017): a cell that only carried
    // one number would make averaging the first token time into the total the
    // obvious thing to do.
    const engine = fakeEngine((request) => resultsFor(request, () => ({})));
    const h = await harness(engine);
    const created = benchmarkRunSchema.parse(
      await (await call(h.app, RUNS, { method: 'POST', cookie: h.cookie, body: INPUT })).json(),
    );

    const done = await settled(h, created.id);
    const cell = done.results[0];
    expect(cell?.ttftMs).toBe(190);
    expect(cell?.latencyMs).toBe(800);
  });

  it('records the score promptfoo graded, and the rubric it was graded against', async () => {
    const engine = fakeEngine((request) =>
      resultsFor(request, (_variant, target) =>
        target.startsWith('openai')
          ? {}
          : { gradingResult: { score: 0 }, success: true },
      ),
    );
    const h = await harness(engine);
    const created = benchmarkRunSchema.parse(
      await (await call(h.app, RUNS, { method: 'POST', cookie: h.cookie, body: INPUT })).json(),
    );

    const done = await settled(h, created.id);
    expect(done.rubric).toEqual([{ kind: 'contains', value: 'summar' }]);
    expect(done.results.find((cell) => cell.providerId === 'openai')?.qualityScore).toBe(1);
    expect(done.results.find((cell) => cell.providerId === 'anthropic')?.qualityScore).toBe(0);
  });

  it('leaves the score null when the run has no rubric', async () => {
    // An unscored run is legitimate: it measures speed and cost, and the score
    // column reads "—" because nothing graded it.
    const engine = fakeEngine((request) =>
      resultsFor(request, () => ({ gradingResult: {} })),
    );
    const h = await harness(engine);
    const created = benchmarkRunSchema.parse(
      await (
        await call(h.app, RUNS, {
          method: 'POST',
          cookie: h.cookie,
          body: { ...INPUT, rubric: [] },
        })
      ).json(),
    );

    const done = await settled(h, created.id);
    expect(done.rubric).toEqual([]);
    expect(done.results.every((cell) => cell.qualityScore === null)).toBe(true);
  });

  it('hands promptfoo a config naming every variant and every target', async () => {
    const engine = fakeEngine((request) => resultsFor(request, () => ({})));
    const h = await harness(engine);
    const created = benchmarkRunSchema.parse(
      await (await call(h.app, RUNS, { method: 'POST', cookie: h.cookie, body: INPUT })).json(),
    );
    await settled(h, created.id);

    const request = engine.requests[0];
    expect(request?.document['prompts']).toEqual([
      { label: expect.any(String), raw: 'Summarise the contract in 40 words.' },
      { label: expect.any(String), raw: 'Summarise the report in 25 words.' },
    ]);
    expect(request?.document['tests']).toEqual([
      { assert: [{ type: 'contains', value: 'summar' }] },
    ]);
    // The workspace is the run's own directory, so its config, output and cache
    // are all cleaned up together and the run can be re-driven by hand.
    expect(request?.workspace).toContain(created.id);
    expect(request?.providerFile).toBe('provider.cjs');
  });

  it('records a run whose every cell failed as failed', async () => {
    // The difference matters to an operator scanning the list: "succeeded" with a
    // table of failures is a lie the list would tell.
    const engine = fakeEngine((request) =>
      resultsFor(request, () => ({
        success: false,
        error: 'rutekit answered 503',
        // The signal that means "the call failed" rather than "the rubric was
        // unhappy", which is what promptfoo sets on a request it could not make.
        response: { error: 'rutekit answered 503' },
      })),
    );
    const h = await harness(engine);
    const created = benchmarkRunSchema.parse(
      await (await call(h.app, RUNS, { method: 'POST', cookie: h.cookie, body: INPUT })).json(),
    );

    const done = await settled(h, created.id);
    expect(done.status).toBe('failed');
    expect(done.results.every((cell) => cell.status === 'failed')).toBe(true);
  });

  it('fails the run when the engine is not installed, and says what to do', async () => {
    // promptfoo is a dependency, so it is normally there — but a machine without
    // it gets a failed run rather than a server that will not start.
    const server = makeServer({ benchmarkEngine: null });
    server.lifecycle.markReady();
    servers.push(server);
    const app = buildApp(server);
    const cookie = await signIn(app);

    const created = benchmarkRunSchema.parse(
      await (
        await call(app, RUNS, { method: 'POST', cookie, body: INPUT })
      ).json(),
    );
    const done = await settled({ server, app, cookie, engine: fakeEngine(() => ({})) }, created.id);

    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/promptfoo is not installed/);
  });

  it('refuses an anonymous caller', async () => {
    const h = await harness(fakeEngine(() => ({})));
    expect((await call(h.app, RUNS, { method: 'POST', body: INPUT })).status).toBe(401);
  });

  it('refuses a body the contract does not accept', async () => {
    const h = await harness(fakeEngine(() => ({})));
    const response = await call(h.app, RUNS, {
      method: 'POST',
      cookie: h.cookie,
      body: { ...INPUT, targets: [] },
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).kind).toBe('invalid_request');
  });
});

/* ---- The key's lifetime ---- */

describe('the key a run mints', () => {
  it('is scoped to the run’s models, and revoked when the run ends', async () => {
    // The run authenticates like any other client of this instance, and the key
    // it does it with is worth nothing outside the run and nothing after it.
    const engine = fakeEngine((request) => resultsFor(request, () => ({})));
    const h = await harness(engine);

    const before = h.server.apiKeys.list({ q: '', sort: null, direction: 'desc', limit: 100, cursor: null, state: null });
    expect(before.items).toEqual([]);

    const created = benchmarkRunSchema.parse(
      await (await call(h.app, RUNS, { method: 'POST', cookie: h.cookie, body: INPUT })).json(),
    );
    await settled(h, created.id);

    const after = h.server.apiKeys.list({ q: '', sort: null, direction: 'desc', limit: 100, cursor: null, state: null });
    const minted = after.items.find((key) => key.name.startsWith('benchmark:'));
    expect(minted).toBeDefined();
    expect(minted?.modelsAllowed).toEqual(['gpt-4o-mini', 'claude-3-opus-20240229']);
    // Revoked, not deleted: the row stays as the record that a run happened.
    expect(minted?.revokedAt).not.toBeNull();
  });

  it('gives the key back even when the run fails', async () => {
    // The `finally` is what makes a key with no expiry safe. A run that throws
    // must not leave a live credential behind.
    const engine: BenchmarkEngine = {
      run: () => Promise.reject(new Error('promptfoo exploded')),
    };
    const h = await harness(engine as FakeEngine);

    const created = benchmarkRunSchema.parse(
      await (await call(h.app, RUNS, { method: 'POST', cookie: h.cookie, body: INPUT })).json(),
    );
    const done = await settled(h, created.id);
    expect(done.status).toBe('failed');

    const keys = h.server.apiKeys.list({ q: '', sort: null, direction: 'desc', limit: 100, cursor: null, state: null });
    const minted = keys.items.find((key) => key.name.startsWith('benchmark:'));
    expect(minted?.revokedAt).not.toBeNull();
  });

  it('never puts the key in the config the child reads', async () => {
    // It arrives in the environment, so it is not in a file that outlives the
    // run — the workspace is kept so an operator can re-run the YAML by hand.
    const engine = fakeEngine((request) => resultsFor(request, () => ({})));
    const h = await harness(engine);
    const created = benchmarkRunSchema.parse(
      await (await call(h.app, RUNS, { method: 'POST', cookie: h.cookie, body: INPUT })).json(),
    );
    await settled(h, created.id);

    const request = engine.requests[0];
    const serialised = JSON.stringify(request?.document);
    expect(serialised).not.toContain(engine.keys[0] ?? 'IMPOSSIBLE');
    expect(serialised).not.toContain('secret');
  });
});

/* ---- The list and the detail ---- */

describe('the run list', () => {
  it('answers with summaries, not with every cell', async () => {
    // A page of twenty runs at a hundred and twenty cells each is a few hundred
    // kilobytes that nothing on the list page reads.
    const engine = fakeEngine((request) => resultsFor(request, () => ({})));
    const h = await harness(engine);
    const created = benchmarkRunSchema.parse(
      await (await call(h.app, RUNS, { method: 'POST', cookie: h.cookie, body: INPUT })).json(),
    );
    await settled(h, created.id);

    const listed = benchmarksResponseSchema.parse(
      await (await call(h.app, RUNS, { cookie: h.cookie })).json(),
    );
    const row = listed.items[0];
    expect(row?.resultCount).toBe(4);
    expect(row?.expectedResultCount).toBe(4);
    // The cell array is not on this shape at all.
    expect(row).not.toHaveProperty('results');
    expect(row?.name).toBe('Summarisation matrix');
  });

  it('searches by name', async () => {
    const h = await harness(fakeEngine((request) => resultsFor(request, () => ({}))));
    await call(h.app, RUNS, { method: 'POST', cookie: h.cookie, body: INPUT });

    const hit = benchmarksResponseSchema.parse(
      await (await call(h.app, `${RUNS}?q=summarisation`, { cookie: h.cookie })).json(),
    );
    expect(hit.total).toBe(1);

    const miss = benchmarksResponseSchema.parse(
      await (await call(h.app, `${RUNS}?q=nothing-like-this`, { cookie: h.cookie })).json(),
    );
    expect(miss.total).toBe(0);
  });

  it('answers not_found for a run that is not there', async () => {
    const h = await harness(fakeEngine(() => ({})));
    const response = await call(h.app, runPath('nope'), { cookie: h.cookie });
    expect(response.status).toBe(404);
  });

  it('refuses an anonymous caller', async () => {
    const h = await harness(fakeEngine(() => ({})));
    expect((await call(h.app, RUNS)).status).toBe(401);
  });
});
