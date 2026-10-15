import { createInterface } from 'node:readline';
import { hostToWorkerSchema, workerToHostSchema, type HostToWorker, type WorkerJob, type WorkerToHost } from '@rutekit/contracts';

import { captchaSolverFromEnv } from './captcha.ts';
import { createFakeDriver } from './drivers/fake.ts';
import { createPlaywrightDriver } from './drivers/playwright.ts';
import type { BrowserDriver } from './driver.ts';
import { JobRunner } from './flow.ts';
import { resolveFlow } from './flows/index.ts';

/**
 * The automation worker (C7b, ADR-0009).
 *
 * A Node process — Playwright supports Node, not Bun, and a browser crash must not
 * take the gateway with it — that reads JSON lines on stdin and writes them on
 * stdout. It is launched by the server, does one job, and exits.
 *
 * **stdout is the protocol and nothing else.** The worker's own diagnostics go to
 * stderr, because a stray `console.log` on stdout is a malformed frame and the
 * host would — correctly — drop it and log a protocol violation. That is why
 * there is no `console.log` anywhere in this package.
 *
 * **`ready` comes first.** The host waits for it before sending the job, so a
 * worker that failed to load its own modules is a failure the host hears about
 * rather than a job that sits `running` with nobody behind it.
 *
 * **Every frame is validated on the way in.** A frame that does not match the
 * contract is dropped with a note on stderr rather than reaching the runner:
 * a version skew between the two processes should be a visible refusal, not a
 * field that quietly reads as `undefined` and drives the wrong branch.
 */

/** Which driver to run. `fake` is what every test uses. */
const DRIVER_ENV = 'RUTEKIT_WORKER_DRIVER';

/**
 * The driver for this job.
 *
 * `fake` is a test seam, and the only reason it is reachable from the shipped
 * entrypoint rather than injected: the integration test spawns this file the way
 * the server does, and a child process cannot be handed a JavaScript object. The
 * environment variable is what makes the real stdio boundary testable end to end.
 */
function driverFor(job: WorkerJob): BrowserDriver {
  if (process.env[DRIVER_ENV] === 'fake') return createFakeDriver();

  const resolved = resolveFlow(job);
  const solver = captchaSolverFromEnv();
  if (resolved.flow === null) {
    // Said on stderr as well as thrown, because the server forwards stderr to its
    // log and the provider's name is what tells an operator which flow is missing.
    process.stderr.write(`[worker] ${resolved.reason ?? 'no flow'}\n`);
  } else if (solver.name === 'none') {
    // Worth one line: it explains why every challenge will park for a human.
    process.stderr.write('[worker] no captcha solver configured; challenges go to the operator\n');
  }

  return createPlaywrightDriver({
    flow: resolved.flow,
    ...(resolved.reason === null ? {} : { noFlowReason: resolved.reason }),
    solver,
  });
}

function write(message: WorkerToHost): void {
  const parsed = workerToHostSchema.safeParse(message);
  if (!parsed.success) {
    // Nothing to do but say so: this is a bug in the worker, and the host would
    // drop the frame anyway.
    process.stderr.write(`[worker] refusing to send a malformed frame: ${parsed.error.message}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(parsed.data)}\n`);
}

function main(): void {
  const workerId = process.env.RUTEKIT_WORKER_ID ?? 'worker';
  let runner: JobRunner | null = null;
  let driver: BrowserDriver | null = null;
  let running: Promise<void> | null = null;
  let stopping = false;

  /**
   * Unwind and exit.
   *
   * It waits for the run that is already in flight — never starts one. Calling
   * `run()` here would walk the batch a second time, which is a bug the smoke
   * test caught as two `item-done` frames for one item: the second pass re-runs
   * every item the first one already imported, and every credential it produced
   * would be stored twice.
   */
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await running?.catch(() => undefined);
    await driver?.close().catch(() => undefined);
    process.exit(0);
  };

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

  lines.on('line', (line) => {
    const text = line.trim();
    if (text === '') return;

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      process.stderr.write('[worker] a frame was not JSON\n');
      return;
    }

    const parsed = hostToWorkerSchema.safeParse(raw);
    if (!parsed.success) {
      process.stderr.write(`[worker] a frame did not match the protocol: ${parsed.error.message}\n`);
      return;
    }
    const message: HostToWorker = parsed.data;

    if (message.type === 'start') {
      // One job per process, so a second `start` is a protocol error rather than
      // a job to queue — and silently replacing the running one would leave the
      // first job's items unaccounted for.
      if (runner !== null) {
        write({
          type: 'failed',
          workerId,
          error: 'this worker has already been given a job',
          retryable: false,
        });
        return;
      }
      driver = driverFor(message.job);
      runner = new JobRunner({ job: message.job, driver, emit: write });
      running = runner.run();
      return;
    }

    if (message.type === 'cancel' || message.type === 'shutdown') {
      runner?.handle(message);
      void stop();
      return;
    }

    runner?.handle(message);
  });

  // stdin closing is the host going away. There is nobody left to report to, so
  // the worker unwinds and exits rather than becoming an orphan holding browsers.
  lines.on('close', () => {
    void stop();
  });

  // Announced only once the loop is listening, so a `start` sent on the strength
  // of this frame cannot arrive before there is something to receive it.
  write({ type: 'ready', workerId });
}

main();
