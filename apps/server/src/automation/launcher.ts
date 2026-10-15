import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { hostToWorkerSchema, workerToHostSchema, type HostToWorker, type WorkerToHost } from '@contracts';

/**
 * Launching an automation worker (C7b, ADR-0009).
 *
 * The worker is a separate Node process — Playwright supports Node, not Bun, and
 * a browser crash must not take the gateway with it — so this is the seam between
 * the two runtimes. It is an interface rather than a function because everything
 * interesting about a job happens *after* the launch: a test drives the whole job
 * lifecycle through a fake worker in-process, and no test needs a browser.
 *
 * **Both ends validate.** Every frame that arrives is parsed against the
 * contract's schema before anything reads it, and a frame that does not fit is
 * dropped with a log line rather than reaching the job manager (R1.7). The worker
 * does the same in the other direction, so a version skew between the two is a
 * visible refusal rather than a field that quietly reads as `undefined`.
 *
 * **A worker that dies is reported, not restarted.** The launcher surfaces the
 * exit; what it means for the job is the manager's decision, and the answer is
 * that the job failed and its in-flight items went back to the queue.
 */

export interface WorkerHandle {
  readonly id: string;
  /** Write one frame. A closed stdin is a worker that is already gone. */
  send(message: HostToWorker): void;
  /** Stop it now. Used by pause and cancel. */
  kill(): void;
  onMessage(handler: (message: WorkerToHost) => void): void;
  /** Once, when the process ends for any reason. */
  onExit(handler: (code: number | null, signal: string | null) => void): void;
}

export interface WorkerLauncher {
  launch(workerId: string): WorkerHandle;
}

export interface SpawnLauncherDeps {
  readonly logger: Logger;
  /** The runtime that runs the worker. Node, not Bun (ADR-0009). */
  readonly nodeBinary: string;
  /** Absolute path to the worker's entrypoint. */
  readonly entrypoint: string;
  /** Environment for the child. Inherited by default. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The real launcher: one Node process per job, speaking JSON lines on stdio.
 *
 * `stdout` is the protocol and nothing else — the worker's own logging goes to
 * stderr, which this forwards to the server's logger. Mixing them would mean a
 * stray `console.log` in the worker reading as a malformed frame.
 *
 * There is no readiness clock here. The manager owns it, because waiting for
 * `ready` is a step of the job's own lifecycle — a worker that never announces
 * itself is a job that failed, and that is the manager's vocabulary, not a
 * process's.
 */
export function createSpawnLauncher(deps: SpawnLauncherDeps): WorkerLauncher {
  return {
    launch(workerId: string): WorkerHandle {
      const child = spawn(deps.nodeBinary, [deps.entrypoint], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...deps.env, RUTEKIT_WORKER_ID: workerId },
      });

      return new SpawnedWorker(workerId, child, deps);
    },
  };
}

class SpawnedWorker implements WorkerHandle {
  readonly id: string;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #logger: Logger;
  readonly #messageHandlers: ((message: WorkerToHost) => void)[] = [];
  readonly #exitHandlers: ((code: number | null, signal: string | null) => void)[] = [];
  /** Frames arrive in chunks; a line can span two of them. */
  #buffer = '';
  #exited = false;

  constructor(workerId: string, child: ChildProcessWithoutNullStreams, deps: SpawnLauncherDeps) {
    this.id = workerId;
    this.#child = child;
    this.#logger = deps.logger;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.#consume(chunk);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // The worker's own logging. Forwarded rather than parsed: it is not the
      // protocol, and a line here must never be read as a frame.
      const text = chunk.trim();
      if (text !== '') this.#logger.debug({ workerId, worker: text }, 'automation worker');
    });

    child.on('error', (cause) => {
      this.#logger.error({ workerId, err: cause }, 'automation worker could not be started');
      this.#finish(null, null);
    });

    child.on('exit', (code, signal) => {
      this.#finish(code, signal);
    });
  }

  send(message: HostToWorker): void {
    if (this.#exited) return;
    // Validated on the way out too: a frame this end cannot describe is a frame
    // the worker would reject, and failing here names the caller.
    const parsed = hostToWorkerSchema.safeParse(message);
    if (!parsed.success) {
      this.#logger.error({ workerId: this.id, err: parsed.error }, 'refusing to send a malformed frame');
      return;
    }
    try {
      this.#child.stdin.write(`${JSON.stringify(parsed.data)}\n`);
    } catch (cause) {
      // A closed pipe is a worker that has already gone; the exit handler is
      // what the manager hears about it.
      this.#logger.warn({ workerId: this.id, err: cause }, 'could not write to the worker');
    }
  }

  kill(): void {
    if (this.#exited) return;
    this.#child.kill('SIGKILL');
  }

  onMessage(handler: (message: WorkerToHost) => void): void {
    this.#messageHandlers.push(handler);
  }

  onExit(handler: (code: number | null, signal: string | null) => void): void {
    this.#exitHandlers.push(handler);
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline === -1) break;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line !== '') this.#dispatch(line);
    }

    // A worker that has written a great deal without a newline is a worker that
    // is not speaking this protocol. The cap keeps a runaway frame from growing
    // without bound in the server's memory.
    if (this.#buffer.length > READY_FRAME_LIMIT) {
      this.#logger.error({ workerId: this.id }, 'automation worker sent an unterminated frame');
      this.#buffer = '';
    }
  }

  #dispatch(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.#logger.warn({ workerId: this.id, line: line.slice(0, 200) }, 'worker frame was not JSON');
      return;
    }

    const parsed = workerToHostSchema.safeParse(raw);
    if (!parsed.success) {
      this.#logger.warn(
        { workerId: this.id, err: parsed.error, type: (raw as { type?: unknown }).type },
        'worker frame did not match the protocol',
      );
      return;
    }

    for (const handler of this.#messageHandlers) handler(parsed.data);
  }

  #finish(code: number | null, signal: string | null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#buffer = '';
    for (const handler of this.#exitHandlers) handler(code, signal);
  }
}

/** A frame larger than this without a newline is not a frame this protocol has. */
const READY_FRAME_LIMIT = 64 * 1024 * 1024;

/** Where the worker's entrypoint lives, given the repository root. */
export function workerEntrypoint(repoRoot: string): string {
  return join(repoRoot, 'tools', 'automation-worker', 'src', 'main.ts');
}
