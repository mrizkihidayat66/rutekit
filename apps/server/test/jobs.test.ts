import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_API_PREFIX,
  consoleErrorSchema,
  consolePaths,
  jobSchema,
  jobsResponseSchema,
} from '@contracts';
import type { Job } from '@contracts';

import { createProviderRegistry } from '@registry';
import { providerManifests } from '@registry/providers/index.ts';

import { buildApp } from '@server/app.ts';
import { SecretBox } from '@server/security/secret-box.ts';
import { createFakeWorker, manualClock, type FakeWorker, type ManualClock } from './fake-worker.ts';
import { makeServer, type MakeServerOptions, type TestServer } from './helpers.ts';

/**
 * Automation jobs (C7b, FR-5.1–5.12).
 *
 * Route-level over the real composition, with the worker replaced by a scripted
 * one that speaks the protocol in-process. What is under test here is the
 * manager: which items a job gets, what a status means, who owns the manual
 * deadline, what happens when the worker dies, and where an imported credential
 * ends up.
 *
 * The clock is fired by hand. A manual deadline is minutes long in production, so
 * the interval is asserted from what was asked for and the expiry is triggered on
 * demand — which is also the only way to assert that the host, and not the worker,
 * is the one that decides.
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

async function errorOf(response: Response): Promise<{ kind: string; message: string }> {
  return consoleErrorSchema.parse(await response.json()).error;
}

const JOBS_PATH = `${CONSOLE_API_PREFIX}${consolePaths.jobs}`;

function jobPath(id: string): string {
  return `${CONSOLE_API_PREFIX}${consolePaths.job.replace(':id', id)}`;
}

function controlPath(id: string): string {
  return `${CONSOLE_API_PREFIX}${consolePaths.jobControl.replace(':id', id)}`;
}

function manualPath(id: string): string {
  return `${CONSOLE_API_PREFIX}${consolePaths.jobManual.replace(':id', id)}`;
}

/**
 * A sign-in job against a provider that declares an automation flow.
 *
 * `kiro` is one of the four OAuth-category providers, and its manifest carries a
 * `startUrl` — which is what the manager checks before it will spawn anything.
 */
const LOGIN_JOB = {
  providerId: 'kiro',
  method: 'bulk-login',
  engine: 'chromium',
  mode: 'headless',
  concurrency: 1,
  proxyId: null,
  payload: 'alice@example.com:pw1\nbob@example.com:pw2',
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

/** Build a server whose worker is the scripted one. */
function serverWith(
  script: Parameters<typeof createFakeWorker>[0] = {},
  options: { registry?: MakeServerOptions['registry'] } = {},
): void {
  // A test may rebuild the server mid-flight; the previous one is closed so its
  // timers and worker do not outlive it.
  if (server !== undefined) server.close();

  worker = createFakeWorker(script);
  clock = manualClock();
  server = makeServer({
    secrets: new SecretBox(KEY_HEX),
    workerLauncher: worker.launcher,
    timers: clock.timers,
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });
  server.lifecycle.markReady();
  app = buildApp(server);
}

/** Let the scripted worker's microtasks run. */
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
  expect(response.status).toBe(200);
  return jobSchema.parse(await response.json());
}

beforeEach(async () => {
  serverWith({ items: ['done'] });
  cookie = await signIn(app);
});

afterEach(() => {
  server.close();
});

describe('creating a job', () => {
  it('masks every credential and never returns the payload', async () => {
    const job = await createJob(app, cookie);

    // The label is what the console shows, and it is masked from the address.
    expect(job.items.map((item) => item.accountLabel)).toEqual([
      'a•••@example.com',
      'b•••@example.com',
    ]);
    // The raw credentials are what the worker is handed and nothing else — they
    // are encrypted on the row and never appear in a read model.
    expect(JSON.stringify(job)).not.toContain('pw1');
    expect(JSON.stringify(job)).not.toContain('alice@');
  });

  it('stores the payload encrypted', async () => {
    const job = await createJob(app, cookie);

    const stored = server.persistence.sqlite
      .query<{ payload_envelope: string | null }, [string]>(
        'select payload_envelope from jobs where id = ?',
      )
      .get(job.id);

    expect(stored?.payload_envelope).not.toBeNull();
    expect(stored?.payload_envelope ?? '').not.toContain('pw1');
    // It round-trips through the box, which is what makes a retry possible after
    // a restart.
    expect(server.secrets?.decrypt(stored?.payload_envelope ?? '')).toContain('pw1');
  });

  it('refuses a provider rutekit cannot drive', async () => {
    // Every shipped provider declares an automation block, so the branch that
    // refuses one that does not has no case in the real catalogue. A catalogue
    // with one provider stripped of its flow is what makes the branch testable.
    const template = providerManifests.find((manifest) => manifest.id === 'kiro');
    if (template === undefined) throw new Error('kiro is missing from the catalogue');
    serverWith({}, {
      registry: createProviderRegistry([
        {
          ...template,
          id: 'no-flow',
          name: 'No Flow',
          automation: null,
          // The catalogue's own invariant: `capabilities.automation` says whether
          // a flow is declared, so stripping one without the other is a
          // contradiction the registry refuses to build.
          capabilities: { ...template.capabilities, automation: false },
        },
      ]),
    });
    cookie = await signIn(app);

    const response = await call(app, JOBS_PATH, {
      method: 'POST',
      body: { ...LOGIN_JOB, providerId: 'no-flow' },
      cookie,
    });

    expect(response.status).toBe(400);
    // Refusing here beats spawning a worker that fails on its first line.
    expect((await errorOf(response)).message).toContain('automation');
  });

  it('refuses an unknown provider', async () => {
    const response = await call(app, JOBS_PATH, {
      method: 'POST',
      body: { ...LOGIN_JOB, providerId: 'no-such-provider' },
      cookie,
    });
    expect(response.status).toBe(404);
  });

  it('refuses an empty payload', async () => {
    const response = await call(app, JOBS_PATH, {
      method: 'POST',
      body: { ...LOGIN_JOB, payload: '\n  \n' },
      cookie,
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain('no usable lines');
  });

  it('refuses a registration with no SMS key to rent numbers from', async () => {
    const response = await call(app, JOBS_PATH, {
      method: 'POST',
      body: { ...LOGIN_JOB, method: 'bulk-regist', payload: '', quantity: 2 },
      cookie,
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain('SMS provider');
  });

  it('builds a registration batch out of a quantity, not a payload', async () => {
    const job = await createJob(app, cookie, {
      ...LOGIN_JOB,
      method: 'bulk-regist',
      payload: '',
      quantity: 3,
      smsProviderId: 'sms_1',
    });

    expect(job.total).toBe(3);
    // A registration creates accounts rather than signing them in, so there is no
    // credential to mask — the rented number is the row's identity.
    expect(job.items.map((item) => item.accountLabel)).toEqual([
      '+1 (555) 100-1000',
      '+1 (555) 101-1007',
      '+1 (555) 102-1014',
    ]);
  });

  it('reads a pipe-separated payload, which FR-5.1 asks for', async () => {
    const job = await createJob(app, cookie, {
      ...LOGIN_JOB,
      payload: 'carol@example.com|pw3',
    });

    expect(job.items.map((item) => item.accountLabel)).toEqual(['c•••@example.com']);
  });
});

describe('running a job', () => {
  it('spawns a worker and hands it the batch', async () => {
    await createJob(app, cookie);
    await settle();

    const started = worker.job();
    expect(started).not.toBeNull();
    // The credentials travel to the worker; the labels do too, so a step the
    // worker reports can name the row it belongs to.
    expect(started?.items.map((item) => item.credential)).toEqual([
      'alice@example.com:pw1',
      'bob@example.com:pw2',
    ]);
  });

  it('marks an imported item succeeded and stores the credential as an account', async () => {
    serverWith({ items: ['done', 'done'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    const updated = await readJob(app, cookie, job.id);
    expect(updated.succeeded).toBe(2);
    expect(updated.failed).toBe(0);
    expect(updated.status).toBe('succeeded');
    expect(updated.items.every((item) => item.status === 'succeeded')).toBe(true);

    // The credential the worker produced lands in the account pool, through the
    // same service an operator's hand-added account goes through.
    const accounts = server.accounts.listByProvider('kiro');
    expect(accounts).toHaveLength(2);
    const stored = accounts.map((account) =>
      server.secrets?.decrypt(account.credentialEnvelope) ?? '',
    );
    // Both credentials the worker produced are stored, and each names the item it
    // came from — which is how a batch's accounts are traceable back to their row.
    expect(stored).toHaveLength(2);
    expect(stored.every((credential) => credential.startsWith('fake:'))).toBe(true);
    expect(stored[0]).not.toBe(stored[1]);
  });

  it('records a failed item with its error and does not stop the batch', async () => {
    serverWith({ items: ['failed', 'done'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    const updated = await readJob(app, cookie, job.id);
    expect(updated.succeeded).toBe(1);
    expect(updated.failed).toBe(1);
    // One credential lost does not make the run a success, so the job is failed
    // even though most of it worked — the operator needs to see the shortfall.
    expect(updated.status).toBe('failed');
    expect(updated.items[0]?.lastError).toContain('refused');
  });

  it('keeps the steps a worker reported, in order', async () => {
    serverWith({ items: ['done'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    const updated = await readJob(app, cookie, job.id);
    expect(updated.items[0]?.steps.map((step) => step.name)).toEqual(['open']);
  });

  it('reports a job-level worker failure and re-queues what was in flight', async () => {
    serverWith({ jobFails: 'no browser is installed' });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    const updated = await readJob(app, cookie, job.id);
    expect(updated.status).toBe('failed');
    // Nothing was judged, so the items go back to the queue rather than being
    // written off — a retry can pick them up.
    expect(updated.items.every((item) => item.status === 'queued')).toBe(true);
  });
});

describe('the manual hand-off', () => {
  it('parks the item, sets a deadline, and announces it', async () => {
    serverWith({ items: ['manual', 'done'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    const parked = await readJob(app, cookie, job.id);
    expect(parked.status).toBe('needs_manual');
    expect(parked.needsManual).toBe(1);
    // The host owns the clock, and the interval is the provider's own allowance.
    expect(parked.manualDeadlineAt).not.toBeNull();
    expect(clock.delays).toContain(180_000);
  });

  it('sends the operator’s answer to the worker', async () => {
    serverWith({ items: ['manual'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    const parked = await readJob(app, cookie, job.id);
    const itemId = parked.items[0]?.id ?? '';
    const response = await call(app, manualPath(job.id), {
      method: 'POST',
      body: { itemId, solution: 'AB12C' },
      cookie,
    });

    expect(response.status).toBe(200);
    expect(worker.sent.some((frame) => frame.type === 'manual-answer')).toBe(true);

    await settle();
    const answered = await readJob(app, cookie, job.id);
    expect(answered.succeeded).toBe(1);
    // The answer is what the worker used to obtain the credential.
    const accounts = server.accounts.listByProvider('kiro');
    expect(server.secrets?.decrypt(accounts[0]?.credentialEnvelope ?? '')).toBe('answer:AB12C');
  });

  it('clears the deadline once an answer arrives', async () => {
    serverWith({ items: ['manual'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    const parked = await readJob(app, cookie, job.id);
    const deadlineDelays = clock.delays.filter((delay) => delay === 180_000).length;

    await call(app, manualPath(job.id), {
      method: 'POST',
      body: { itemId: parked.items[0]?.id ?? '', solution: 'AB12C' },
      cookie,
    });

    // The countdown the console shows and the clock that abandons the item are
    // the same one, so answering has to stop it. Counted by the interval it was
    // armed with rather than by the total, because the stall clock is pending too
    // — it re-arms once the item stops waiting for a human.
    expect(clock.delays.filter((delay) => delay === 180_000).length).toBe(deadlineDelays);
  });

  it('abandons the item when the deadline passes, and carries on', async () => {
    serverWith({ items: ['manual'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    clock.fire(180_000);
    await settle();

    const abandoned = await readJob(app, cookie, job.id);
    expect(abandoned.failed).toBe(1);
    expect(abandoned.needsManual).toBe(0);
    expect(abandoned.items[0]?.lastError).toContain('deadline');
    // The worker is told to give up on that item specifically, rather than being
    // cancelled — the rest of the batch is still worth running.
    expect(worker.sent.some((frame) => frame.type === 'abandon-item')).toBe(true);
  });

  it('refuses an answer for a job that is not waiting', async () => {
    serverWith({ items: ['done'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    const done = await readJob(app, cookie, job.id);
    const response = await call(app, manualPath(job.id), {
      method: 'POST',
      body: { itemId: done.items[0]?.id ?? '', solution: 'late' },
      cookie,
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain('not waiting');
  });
});

describe('controlling a job', () => {
  it('marks an item in flight as running', async () => {
    serverWith({ items: ['hang'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    // The worker reported a step, which is what proves the item is mid-air — so
    // an operator watching a live job sees which credentials are actually moving.
    const running = await readJob(app, cookie, job.id);
    expect(running.items[0]?.status).toBe('running');
    expect(running.items[0]?.startedAt).not.toBeNull();
  });

  it('pauses by killing the worker and returning its items to the queue', async () => {
    serverWith({ items: ['hang', 'done'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    const response = await call(app, controlPath(job.id), {
      method: 'POST',
      body: { action: 'pause' },
      cookie,
    });

    const paused = (await response.json()) as Job;
    expect(paused.status).toBe('paused');
    expect(worker.killed()).toBe(true);
    // Freeze: the in-flight items go back to the queue. A browser part-way
    // through a sign-in cannot be frozen, so stopping it is the honest reading —
    // and this is the cost of that choice, made visible.
    expect(paused.items.every((item) => item.status === 'queued')).toBe(true);
  });

  it('resumes a paused job by spawning a fresh worker', async () => {
    serverWith({ items: ['done'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    await call(app, controlPath(job.id), { method: 'POST', body: { action: 'pause' }, cookie });
    const before = worker.sent.filter((frame) => frame.type === 'start').length;

    const response = await call(app, controlPath(job.id), {
      method: 'POST',
      body: { action: 'resume' },
      cookie,
    });

    const resumed = (await response.json()) as Job;
    expect(resumed.status).toBe('running');
    // A second `start` went out, which is what "the worker was replaced" means.
    expect(worker.sent.filter((frame) => frame.type === 'start').length).toBe(before + 1);
  });

  it('refuses to resume a job that is not paused', async () => {
    serverWith({ items: ['done'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    const response = await call(app, controlPath(job.id), {
      method: 'POST',
      body: { action: 'resume' },
      cookie,
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain('resumed');
  });

  it('cancels and stops the worker', async () => {
    serverWith({ items: ['done'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    const response = await call(app, controlPath(job.id), {
      method: 'POST',
      body: { action: 'cancel' },
      cookie,
    });

    const cancelled = (await response.json()) as Job;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finishedAt).not.toBeNull();
    expect(worker.killed()).toBe(true);
  });

  it('retries the failures and leaves the successes alone', async () => {
    serverWith({ items: ['failed', 'done'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    const before = await readJob(app, cookie, job.id);
    expect(before.failed).toBe(1);

    const response = await call(app, controlPath(job.id), {
      method: 'POST',
      body: { action: 'retry_failed' },
      cookie,
    });

    expect(response.status).toBe(200);
    const retried = (await response.json()) as Job;
    // Only the failed row goes back; the one that already imported is not run
    // again, which is the difference between retry and re-run.
    expect(retried.items[0]?.status).toBe('queued');
    expect(retried.items[1]?.status).toBe('succeeded');
    expect(retried.succeeded).toBe(1);
  });

  it('refuses a retry with nothing to retry', async () => {
    serverWith({ items: ['done'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    const response = await call(app, controlPath(job.id), {
      method: 'POST',
      body: { action: 'retry_failed' },
      cookie,
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain('no failed items');
  });
});

describe('a worker that dies', () => {
  it('fails the job and returns its in-flight items to the queue', async () => {
    serverWith({ silent: true });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    worker.crash();
    await settle();

    const updated = await readJob(app, cookie, job.id);
    expect(updated.status).toBe('failed');
    // The items were interrupted, not judged, so a retry can pick them up.
    expect(updated.items.every((item) => item.status === 'queued')).toBe(true);
  });

  it('does nothing when the worker exits after the job already landed', async () => {
    serverWith({ items: ['done'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    expect((await readJob(app, cookie, job.id)).status).toBe('succeeded');

    // The ordinary exit after `done` is not a crash, and it must not overwrite a
    // job that finished cleanly.
    worker.crash(0);
    await settle();

    expect((await readJob(app, cookie, job.id)).status).toBe('succeeded');
  });

  it('fails the job when the worker never announces itself', async () => {
    serverWith({ ready: false });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);

    // The readiness clock is what keeps a worker that failed to load its own
    // modules from leaving a job `running` for ever.
    expect(clock.delays).toContain(30_000);
    clock.fire(30_000);
    await settle();

    const updated = await readJob(app, cookie, job.id);
    expect(updated.status).toBe('failed');
    expect(updated.items.every((item) => item.status === 'queued')).toBe(true);
  });
});

describe('recovering from a restart', () => {
  it('marks a job a previous process left running as failed', async () => {
    serverWith({ items: ['done'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    // Simulate the process having died mid-flight: the row still says `running`
    // and there is no worker behind it.
    server.persistence.sqlite
      .query('update jobs set status = ?, finished_at = null where id = ?')
      .run('running', job.id);
    server.persistence.sqlite
      .query('update job_items set status = ? where job_id = ?')
      .run('running', job.id);

    server.jobs.recover();

    const recovered = await readJob(app, cookie, job.id);
    expect(recovered.status).toBe('failed');
    expect(recovered.items[0]?.status).toBe('queued');
    // Saying why is what makes this actionable rather than mysterious.
    expect(recovered.items[0]?.lastError).toBeNull();
    const row = server.persistence.sqlite
      .query<{ last_error: string | null }, [string]>('select last_error from jobs where id = ?')
      .get(job.id);
    expect(row?.last_error).toContain('restart');
  });

  it('leaves a finished job alone', async () => {
    serverWith({ items: ['done'] });
    cookie = await signIn(app);
    const job = await createJob(app, cookie);
    await settle();

    server.jobs.recover();

    expect((await readJob(app, cookie, job.id)).status).toBe('succeeded');
  });
});

describe('listing jobs', () => {
  it('carries no items, so a page of jobs is not a page of ledgers', async () => {
    await createJob(app, cookie);
    await settle();

    const page = jobsResponseSchema.parse(
      await (await call(app, JOBS_PATH, { cookie })).json(),
    );

    expect(page.total).toBe(1);
    expect(page.items[0]?.items).toEqual([]);
  });

  it('filters by provider and status', async () => {
    serverWith({ items: ['done'] });
    cookie = await signIn(app);
    await createJob(app, cookie);
    await settle();

    const byProvider = jobsResponseSchema.parse(
      await (await call(app, `${JOBS_PATH}?providerId=kiro`, { cookie })).json(),
    );
    expect(byProvider.total).toBe(1);

    const none = jobsResponseSchema.parse(
      await (await call(app, `${JOBS_PATH}?providerId=qoder`, { cookie })).json(),
    );
    expect(none.total).toBe(0);

    const succeeded = jobsResponseSchema.parse(
      await (await call(app, `${JOBS_PATH}?status=succeeded`, { cookie })).json(),
    );
    expect(succeeded.total).toBe(1);
  });

  it('refuses an unknown status rather than answering everything', async () => {
    const response = await call(app, `${JOBS_PATH}?status=exploded`, { cookie });
    expect(response.status).toBe(400);
  });

  it('answers not_found for a job that does not exist', async () => {
    const response = await call(app, jobPath('nope'), { cookie });
    expect(response.status).toBe(404);
  });
});

describe('the session guard', () => {
  it('refuses the job list without a session', async () => {
    const response = await call(app, JOBS_PATH);
    expect(response.status).toBe(401);
    expect((await errorOf(response)).kind).toBe('authentication');
  });
});
