import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONSOLE_API_PREFIX, consolePaths, jobSchema, type Job } from '@contracts';

import { effectiveConcurrency, machineLimit } from '@server/automation/capacity.ts';
import { buildApp } from '@server/app.ts';
import { SecretBox } from '@server/security/secret-box.ts';
import { createFakeWorker, manualClock, type FakeWorker, type ManualClock } from './fake-worker.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * Supervising a job (C7c, FR-5.7, FR-5.8, FR-5.10).
 *
 * The three things the host does that the worker cannot: it decides when a silent
 * worker is stuck, it caps a batch to what the machine can carry, and it opens a
 * manual session for an operator taking an item over. All three are policy about
 * a machine and a clock, so all three are tested here rather than in the worker's
 * own suite.
 */

const PASSWORD = 'correct-horse-battery';
const KEY_HEX = 'ab'.repeat(32);

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

const JOBS_PATH = `${CONSOLE_API_PREFIX}${consolePaths.jobs}`;

function jobPath(id: string): string {
  return `${CONSOLE_API_PREFIX}${consolePaths.job.replace(':id', id)}`;
}

function sessionPath(id: string): string {
  return `${CONSOLE_API_PREFIX}${consolePaths.jobSession.replace(':id', id)}`;
}

const LOGIN_JOB = {
  providerId: 'kiro',
  method: 'bulk-login',
  engine: 'chromium',
  mode: 'headless',
  concurrency: 1,
  proxyId: null,
  payload: 'alice@example.com:pw1',
  maxAttempts: 3,
  smsProviderId: null,
  quantity: null,
  country: null,
  operator: null,
  product: null,
};

let server: TestServer;
let app: App;
let cookie: string;
let worker: FakeWorker;
let clock: ManualClock;

function serverWith(
  script: Parameters<typeof createFakeWorker>[0] = {},
  capacity?: { cores: number; freeMemoryBytes: number },
): void {
  if (server !== undefined) server.close();
  worker = createFakeWorker(script);
  clock = manualClock();
  server = makeServer({
    secrets: new SecretBox(KEY_HEX),
    workerLauncher: worker.launcher,
    timers: clock.timers,
    ...(capacity === undefined ? {} : { capacity: { read: () => capacity } }),
  });
  server.lifecycle.markReady();
  app = buildApp(server);
}

function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function createJob(app: App, cookie: string, body: unknown = LOGIN_JOB): Promise<Job> {
  const response = await call(app, JOBS_PATH, { method: 'POST', body, cookie });
  expect(response.status).toBe(201);
  return (await response.json()) as Job;
}

async function readJob(app: App, cookie: string, id: string): Promise<Job> {
  const response = await call(app, jobPath(id), { cookie });
  return jobSchema.parse(await response.json());
}

/** The stall clock is armed at this interval. */
const STALL_MS = 5 * 60_000;

beforeEach(async () => {
  serverWith({ items: ['done'] });
  cookie = await signIn(app);
});

afterEach(() => {
  server.close();
});

describe('what the machine will carry (FR-5.8)', () => {
  it('leaves a request the machine can carry alone', () => {
    // Plenty of both, so the operator's number is the answer.
    const result = effectiveConcurrency(4, { cores: 16, freeMemoryBytes: 32 * 1024 ** 3 });

    expect(result.value).toBe(4);
    expect(result.capped).toBe(false);
  });

  it('holds a request down to what the cores allow', () => {
    // Four cores, one reserved, so three contexts — however many were asked for.
    const result = effectiveConcurrency(12, { cores: 4, freeMemoryBytes: 64 * 1024 ** 3 });

    expect(result.value).toBe(3);
    expect(result.capped).toBe(true);
  });

  it('holds a request down to what the memory allows', () => {
    // Many cores, little free memory: a browser context is a renderer process,
    // and thirty-two cores do not make room for eight of them in 2 GB.
    const result = effectiveConcurrency(8, { cores: 32, freeMemoryBytes: 2 * 1024 ** 3 });

    expect(result.value).toBe(4);
    expect(result.capped).toBe(true);
  });

  it('never caps below one', () => {
    // A machine under pressure still has to be able to run a job; a cap of zero
    // would read as a broken job rather than a busy machine.
    const result = effectiveConcurrency(4, { cores: 1, freeMemoryBytes: 64 * 1024 ** 2 });

    expect(result.value).toBe(1);
    expect(result.capped).toBe(true);
  });

  it('never raises a request above what was asked for', () => {
    // The cap is a ceiling, never a floor: an operator asking for one is usually
    // debugging a flow, and a machine that gave them four would be overriding them.
    const result = effectiveConcurrency(1, { cores: 32, freeMemoryBytes: 64 * 1024 ** 3 });

    expect(result.value).toBe(1);
    expect(result.capped).toBe(false);
  });

  it('reports the machine it measured', () => {
    const limit = machineLimit({ cores: 8, freeMemoryBytes: 16 * 1024 ** 3 });

    expect(limit.cores).toBe(8);
    expect(limit.limit).toBe(7);
  });
});

describe('a job the machine capped', () => {
  it('records the cap and hands the worker the capped number', async () => {
    serverWith({ items: ['done'] }, { cores: 2, freeMemoryBytes: 64 * 1024 ** 3 });
    cookie = await signIn(app);

    const job = await createJob(app, cookie, { ...LOGIN_JOB, concurrency: 8 });
    await settle();

    // Two cores less the reserved one leaves a single context.
    expect(job.concurrency).toBe(8);
    expect(job.effectiveConcurrency).toBe(1);
    // And the worker was told one, so it does not open eight contexts and hope.
    expect(worker.job()?.concurrency).toBe(1);
  });

  it('leaves the field null when nothing was capped', async () => {
    serverWith({ items: ['done'] }, { cores: 32, freeMemoryBytes: 64 * 1024 ** 3 });
    cookie = await signIn(app);

    const job = await createJob(app, cookie, { ...LOGIN_JOB, concurrency: 3 });

    // The ordinary case: a null rather than the same figure repeated.
    expect(job.effectiveConcurrency).toBeNull();
    expect(job.concurrency).toBe(3);
  });
});

describe('a worker that goes quiet (FR-5.10)', () => {
  it('kills it and fails the job', async () => {
    // Announced itself and then went quiet, which is what a stuck browser looks
    // like: the readiness clock already cleared, so the stall clock is what fires.
    serverWith({ silent: true, items: ['hang'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    // The stall clock is armed at five minutes.
    expect(clock.delays).toContain(STALL_MS);
    clock.fire(STALL_MS);
    await settle();

    const stalled = await readJob(app, cookie, job.id);
    expect(stalled.status).toBe('failed');
    expect(worker.killed()).toBe(true);
    // The items were interrupted rather than judged, so a retry can pick them up.
    expect(stalled.items.every((item) => item.status === 'queued')).toBe(true);
  });

  it('does not fire while the job is parked on a human', async () => {
    // The worker reported a challenge and then went quiet — which is the state
    // FR-5.4 asks it to sit in, not a stall.
    serverWith({ items: ['manual'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    expect((await readJob(app, cookie, job.id)).status).toBe('needs_manual');

    // The stall interval elapses while the operator is still thinking. The check
    // finds the job parked and stands down rather than killing the worker — which
    // is the whole point: a job waiting for a person is silent by design, and a
    // watchdog that counted that silence would kill exactly the jobs that need one.
    const before = clock.delays.filter((delay) => delay === STALL_MS).length;
    clock.fire(STALL_MS);
    await settle();

    const parked = await readJob(app, cookie, job.id);
    expect(parked.status).toBe('needs_manual');
    expect(worker.killed()).toBe(false);
    // And it re-armed, so the job is still watched — it is standing down, not
    // switching the watchdog off.
    expect(clock.delays.filter((delay) => delay === STALL_MS).length).toBeGreaterThan(before);
  });

  it('does not fire while the worker is still talking', async () => {
    serverWith({ items: ['hang'] });
    cookie = await signIn(app);
    await createJob(app, cookie);
    await settle();

    // Every frame re-arms the clock, so a job that keeps reporting never trips it
    // however long it runs — which is what makes a five-minute threshold safe.
    const stalls = clock.delays.filter((delay) => delay === STALL_MS).length;
    expect(stalls).toBeGreaterThanOrEqual(1);

    worker.emit({
      type: 'step',
      workerId: 'w',
      itemId: 'i',
      index: 1,
      name: 'still working',
      status: 'ok',
      detail: null,
    });
    await settle();

    expect(clock.delays.filter((delay) => delay === STALL_MS).length).toBeGreaterThan(stalls);
  });
});

describe('a manual session (FR-5.7)', () => {
  it('tells the worker to re-capture the page', async () => {
    serverWith({ items: ['manual'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    const parked = await readJob(app, cookie, job.id);
    const response = await call(app, sessionPath(job.id), {
      method: 'POST',
      body: { itemId: parked.items[0]?.id ?? '' },
      cookie,
    });

    expect(response.status).toBe(200);
    // The worker re-captures, which is what refreshes the console's frame and
    // restarts the deadline when its report arrives.
    expect(worker.sent.some((frame) => frame.type === 'manual-open')).toBe(true);
  });

  it('refuses an item that is not waiting for an answer', async () => {
    serverWith({ items: ['done'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    const done = await readJob(app, cookie, job.id);
    const response = await call(app, sessionPath(job.id), {
      method: 'POST',
      body: { itemId: done.items[0]?.id ?? '' },
      cookie,
    });

    // There is nothing to open on a working item, and reporting a challenge for
    // one would park it for a person who has nothing to do.
    expect(response.status).toBe(400);
  });

  it('refuses a job that is not running', async () => {
    serverWith({ items: ['done'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    const response = await call(app, sessionPath(job.id), {
      method: 'POST',
      body: { itemId: 'anything' },
      cookie,
    });

    expect(response.status).toBe(400);
  });
});
