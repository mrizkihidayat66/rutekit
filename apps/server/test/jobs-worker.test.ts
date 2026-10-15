import { afterEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_API_PREFIX,
  consolePaths,
  jobSchema,
  type Job,
} from '@contracts';

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createSpawnLauncher, workerEntrypoint } from '@server/automation/launcher.ts';
import { buildApp } from '@server/app.ts';
import { silentLogger } from '@server/observability/logger.ts';
import { SecretBox } from '@server/security/secret-box.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The real worker, over the real pipe (C7b, ADR-0009).
 *
 * `jobs.test.ts` drives the manager with a scripted worker in-process, which is
 * what makes the lifecycle cheap to assert. This file does the opposite: it
 * spawns the actual Node process the server spawns, with the worker's fake driver
 * selected by environment, and runs a job through it end to end.
 *
 * That is the only test that proves the boundary itself — that the two runtimes
 * agree on the protocol, that a frame survives a pipe, that the child's stdout
 * carries nothing but protocol, and that the worker exits when it is done. A
 * schema test cannot prove any of it, and an in-process double proves the
 * opposite of it.
 *
 * The driver is fake because a real browser is not something a test box can
 * drive; everything around it — spawn, `ready`, `start`, steps, `item-done`,
 * `done`, exit — is the shipped code.
 */

const PASSWORD = 'correct-horse-battery';
const KEY_HEX = 'ab'.repeat(32);

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

/**
 * The repository root, from this file's own location.
 *
 * `repoRoot()` in `runtime/config.ts` uses `import.meta.dir`, which is Bun's and
 * not Node's — and this suite runs under the Node the worker ships on, so the
 * path is computed here instead. That is a real difference between the two
 * runtimes and worth naming rather than papering over: the server is Bun, the
 * worker is Node, and only the server ever calls `repoRoot()`.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * A server whose job manager spawns the real worker.
 *
 * `RUTEKIT_WORKER_DRIVER=fake` is what makes the child run without a browser —
 * see `tools/automation-worker/src/main.ts`. The binary is `node`, which is what
 * `RUTEKIT_NODE_BINARY` defaults to and what the worker actually ships on.
 */
function realWorkerServer(): TestServer {
  const server = makeServer({
    secrets: new SecretBox(KEY_HEX),
    workerLauncher: createSpawnLauncher({
      logger: silentLogger(),
      // `node`, which is what `RUTEKIT_NODE_BINARY` defaults to and what the
      // worker actually ships on (ADR-0009).
      nodeBinary: 'node',
      entrypoint: workerEntrypoint(REPO_ROOT),
      env: { RUTEKIT_WORKER_DRIVER: 'fake' },
    }),
  });
  server.lifecycle.markReady();
  servers.push(server);
  return server;
}

/**
 * Wait until the job stops moving, or give up.
 *
 * The worker is a separate process, so nothing here can be awaited directly — the
 * job's status is the only signal, and polling it is the honest way to wait for a
 * boundary this test does not own.
 */
async function waitForSettled(app: App, cookie: string, id: string): Promise<Job> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await app.request(`${CONSOLE_API_PREFIX}${consolePaths.job.replace(':id', id)}`, {
      headers: { cookie },
    });
    const job = jobSchema.parse(await response.json());
    if (job.status !== 'queued' && job.status !== 'running' && job.status !== 'needs_manual') {
      return job;
    }
    if (Date.now() > deadline) {
      throw new Error(`job ${id} did not settle; last status was ${job.status}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
}

describe('a job driven by the real worker process', () => {
  it('imports a batch end to end', async () => {
    const server = realWorkerServer();
    const app = buildApp(server);
    const cookie = await signIn(app);

    const created = await app.request(`${CONSOLE_API_PREFIX}${consolePaths.jobs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        providerId: 'kiro',
        method: 'bulk-login',
        engine: 'chromium',
        mode: 'headless',
        concurrency: 2,
        proxyId: null,
        // The fake driver reads the credential to decide what to do: `plain`
        // imports on the first attempt, `flaky` fails retryably once first.
        payload: 'alice@example.com:plain\nbob@example.com:flaky',
        maxAttempts: 3,
        smsProviderId: null,
        quantity: null,
        country: null,
        operator: null,
        product: null,
      }),
    });

    expect(created.status).toBe(201);
    const job = (await created.json()) as Job;

    const settled = await waitForSettled(app, cookie, job.id);

    // Both imported. `flaky` failed its first attempt and the worker's own
    // backoff loop retried it — which is FR-5.6 working through a real pipe.
    expect(settled.status).toBe('succeeded');
    expect(settled.succeeded).toBe(2);
    expect(settled.failed).toBe(0);

    // And both credentials landed in the pool, stored by the server.
    const accounts = server.accounts.listByProvider('kiro');
    expect(accounts).toHaveLength(2);
    for (const account of accounts) {
      expect(server.secrets?.decrypt(account.credentialEnvelope)).toContain('fake-credential:');
    }
  }, 60_000);

  it('reports a refusal without taking the batch down', async () => {
    const server = realWorkerServer();
    const app = buildApp(server);
    const cookie = await signIn(app);

    const created = await app.request(`${CONSOLE_API_PREFIX}${consolePaths.jobs}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        providerId: 'kiro',
        method: 'bulk-login',
        engine: 'chromium',
        mode: 'headless',
        concurrency: 1,
        proxyId: null,
        payload: 'carol@example.com:refuse\ndave@example.com:plain',
        maxAttempts: 3,
        smsProviderId: null,
        quantity: null,
        country: null,
        operator: null,
        product: null,
      }),
    });
    const job = (await created.json()) as Job;

    const settled = await waitForSettled(app, cookie, job.id);

    expect(settled.succeeded).toBe(1);
    expect(settled.failed).toBe(1);
    // A refusal is not retryable, so the failed row spent exactly one attempt —
    // the worker's own verdict, arriving over the pipe.
    expect(settled.items[0]?.attempts).toBe(1);
    expect(settled.items[0]?.lastError).toContain('refused');
  }, 60_000);
});
