import type { HostToWorker, WorkerJob, WorkerItem, WorkerToHost } from '@rutekit/contracts';

import {
  ItemAbandonedError,
  isRetryable,
  type BrowserDriver,
  type FrameCapture,
  type ImportContext,
  type StepStatus,
} from './driver.ts';

/**
 * Running one job's items (C7b, FR-5.6, FR-5.12).
 *
 * The worker owns the batch: it decides which items run when, how many at once,
 * and how many times a failed one is tried again. That is the whole reason the
 * protocol carries a job rather than an item — the process that can see whether
 * an attempt failed in a way worth repeating is the process that should decide
 * whether to repeat it, and it is the only one that can wait out a backoff
 * without holding a message open.
 *
 * **The retry loop is here, and its arithmetic is fixed.** Base 2 s, doubling per
 * attempt, capped at 15 s (FR-5.6). A failure that is not marked retryable is not
 * retried at all: a credential the provider rejected will be rejected again, and
 * spending an attempt on it costs a slot for nothing.
 *
 * **Abandonment is not a failure.** When the host's manual deadline passes it
 * sends `abandon-item`; the item is reported as failed with that reason and the
 * batch carries on. It deliberately does *not* spend a retry — the operator ran
 * out of time, not the attempt.
 *
 * **The runner never throws at the caller.** Every way a job can end — every item
 * done, cancelled, the driver broken — leaves through a message, because the
 * caller is a stdio loop with nowhere to throw to.
 */

/** Backoff base and cap (FR-5.6). */
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 15_000;

export interface FlowDeps {
  readonly job: WorkerJob;
  readonly driver: BrowserDriver;
  readonly emit: (message: WorkerToHost) => void;
  /** Injectable so a test does not spend real seconds on backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** What the runner is doing with one item. */
interface ItemRun {
  readonly item: WorkerItem;
  readonly controller: AbortController;
  /** How many steps have been reported for this item, for stable ordering. */
  steps: number;
  /** Set while the item is parked on a human. */
  pending: { resolve: (solution: string) => void; reject: (error: unknown) => void } | null;
  /** Why it is parked, and what the page looked like — carried for a re-announce. */
  reason: string;
  frameUrl: string | null;
}

export class JobRunner {
  readonly #deps: FlowDeps;
  readonly #runs = new Map<string, ItemRun>();
  /** Set by `cancel` or `shutdown`: no new item starts, running ones unwind. */
  #stopping = false;
  /** Set once the walk has finished, so a late frame is not acted on. */
  #finished = false;

  constructor(deps: FlowDeps) {
    this.#deps = deps;
  }

  /**
   * A frame from the host.
   *
   * Only three of them mean anything here: an answer unblocks an item, an
   * abandonment aborts one, and a cancel or shutdown stops everything. The rest
   * (`start`, which the loop consumes before this exists) are not the runner's.
   */
  handle(message: HostToWorker): void {
    switch (message.type) {
      case 'manual-answer': {
        const run = this.#runs.get(message.itemId);
        // A late answer to an item that has already moved on is dropped rather
        // than acted on: the deadline passed, the item was abandoned, and the
        // operator's text now belongs to nothing.
        run?.pending?.resolve(message.solution);
        return;
      }
      case 'manual-open': {
        // The operator has started working on it. Reported again, which is what
        // refreshes the console's frame and restarts the host's deadline — the
        // worker does not reset anything itself, because the deadline is the
        // host's (FR-5.7).
        this.#reannounce(message.itemId);
        return;
      }
      case 'abandon-item': {
        this.#abandon(message.itemId, 'the manual deadline passed');
        return;
      }
      case 'cancel':
      case 'shutdown': {
        this.#stopping = true;
        for (const run of this.#runs.values()) this.#abandon(run.item.id, 'the job was stopped');
        return;
      }
      case 'start':
        return;
    }
  }

  /**
   * Report a parked item's challenge again, with a fresh frame.
   *
   * Only for an item that is genuinely parked: an operator opening a session on
   * an item that is not waiting for anything has nothing to open, and inventing a
   * `needs-manual` for it would park a working item for a person.
   */
  #reannounce(itemId: string): void {
    const run = this.#runs.get(itemId);
    if (run === undefined || run.pending === null) return;

    const job = this.#deps.job;
    this.#deps.emit({
      type: 'needs-manual',
      workerId: workerIdOf(job),
      itemId,
      // The reason is carried by the flow, which is what knows it; a re-announce
      // is the same challenge seen again.
      reason: run.reason,
      screenshotUrl: run.frameUrl,
      humanTimeoutSeconds: job.automation?.humanTimeoutSeconds ?? 180,
    });
  }

  /** Walk the batch. Resolves when every item has landed or the job stopped. */
  async run(): Promise<void> {
    try {
      const queue = [...this.#deps.job.items];
      const workers = Array.from(
        { length: Math.max(1, Math.min(this.#deps.job.concurrency, queue.length)) },
        () => this.#drain(queue),
      );
      await Promise.all(workers);
      if (!this.#finished) {
        this.#finished = true;
        this.#deps.emit({ type: 'done', workerId: workerIdOf(this.#deps.job) });
      }
    } catch (cause) {
      // A job-level failure: the driver could not be built, the browser is
      // missing, the proxy is unusable. `retryable` is false because nothing
      // about a second run of the same batch would differ.
      this.#finished = true;
      this.#deps.emit({
        type: 'failed',
        workerId: workerIdOf(this.#deps.job),
        error: cause instanceof Error ? cause.message : 'the worker could not run the job',
        retryable: false,
      });
    }
  }

  /** One worker's loop: take the next item until the queue is empty or stopped. */
  async #drain(queue: WorkerItem[]): Promise<void> {
    for (;;) {
      if (this.#stopping) return;
      const item = queue.shift();
      if (item === undefined) return;
      await this.#runItem(item);
    }
  }

  async #runItem(item: WorkerItem): Promise<void> {
    const run: ItemRun = {
      item,
      controller: new AbortController(),
      steps: 0,
      pending: null,
      reason: '',
      frameUrl: null,
    };
    this.#runs.set(item.id, run);

    const maxAttempts = this.#deps.job.maxAttempts;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (this.#stopping) {
        this.#reportFailure(run, 'the job was stopped', attempt - 1);
        return;
      }

      try {
        const account = await this.#deps.driver.importItem(this.#context(run));
        this.#deps.emit({
          type: 'item-done',
          workerId: workerIdOf(this.#deps.job),
          itemId: item.id,
          credential: account.credential,
          label: account.label,
        });
        return;
      } catch (cause) {
        if (cause instanceof ItemAbandonedError) {
          // Not a retry: the operator ran out of time, not the attempt.
          this.#reportFailure(run, cause.message, attempt);
          return;
        }
        if (isRetryable(cause) && attempt < maxAttempts) {
          this.#step(run, `attempt ${String(attempt)} failed`, 'failed', describe(cause));
          await this.#backoff(attempt);
          continue;
        }
        this.#reportFailure(run, describe(cause), attempt);
        return;
      }
    }
  }

  /** Base 2 s doubling per attempt, capped (FR-5.6). */
  async #backoff(attempt: number): Promise<void> {
    const wait = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
    const sleep = this.#deps.sleep ?? defaultSleep;
    await sleep(wait);
  }

  #context(run: ItemRun): ImportContext {
    const workerId = workerIdOf(this.#deps.job);
    return {
      job: this.#deps.job,
      item: run.item,
      signal: run.controller.signal,
      step: (name, status, detail = null) => {
        this.#step(run, name, status, detail);
      },
      screenshot: (frame: FrameCapture) => {
        this.#deps.emit({
          type: 'screenshot',
          workerId,
          itemId: run.item.id,
          frameUrl: frame.frameUrl,
          width: frame.width,
          height: frame.height,
        });
      },
      askManual: (reason, screenshotUrl) => this.#askManual(run, reason, screenshotUrl),
    };
  }

  /**
   * Park the item and ask a human.
   *
   * The worker reports the challenge and then waits; the host owns the deadline
   * and answers with either `manual-answer` or `abandon-item`. The timeout the
   * worker reports is the provider's own allowance, which is the only part of the
   * interval the worker knows — the host decides what to do with it.
   */
  #askManual(run: ItemRun, reason: string, screenshotUrl: string | null): Promise<string> {
    const job = this.#deps.job;
    return new Promise<string>((resolve, reject) => {
      run.pending = { resolve, reject };
      // Kept on the run so a manual session opened later can report the same
      // challenge again rather than inventing a reason it does not know.
      run.reason = reason;
      run.frameUrl = screenshotUrl;
      this.#deps.emit({
        type: 'needs-manual',
        workerId: workerIdOf(job),
        itemId: run.item.id,
        reason,
        screenshotUrl,
        humanTimeoutSeconds: job.automation?.humanTimeoutSeconds ?? 180,
      });
    });
  }

  /** Give up on one item: unwind whatever is parked on it. */
  #abandon(itemId: string, reason: string): void {
    const run = this.#runs.get(itemId);
    if (run === undefined) return;
    // Abort first, so a driver that is mid-navigation sees the signal before the
    // rejection lands — and a driver that is not waiting on `askManual` at all
    // still stops.
    run.controller.abort();
    const pending = run.pending;
    run.pending = null;
    pending?.reject(new ItemAbandonedError(reason));
  }

  #step(run: ItemRun, name: string, status: StepStatus, detail: string | null): void {
    run.steps += 1;
    this.#deps.emit({
      type: 'step',
      workerId: workerIdOf(this.#deps.job),
      itemId: run.item.id,
      index: run.steps,
      name,
      status,
      detail,
    });
  }

  #reportFailure(run: ItemRun, error: string, attempts: number): void {
    this.#step(run, 'failed', 'failed', error);
    this.#deps.emit({
      type: 'item-failed',
      workerId: workerIdOf(this.#deps.job),
      itemId: run.item.id,
      error,
      attempts,
    });
  }
}

/** The job's own id doubles as the worker's, since a worker is one job. */
function workerIdOf(job: WorkerJob): string {
  return job.jobId;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'the attempt failed';
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
