import type { HostToWorker, WorkerJob, WorkerToHost } from '@contracts';

import type { WorkerHandle, WorkerLauncher } from '@server/automation/launcher.ts';

/**
 * A scripted worker for the manager's tests (C7b).
 *
 * Not a `.test.ts`, so the runner does not treat it as a suite. It speaks the
 * protocol in-process, which is what lets a test drive a job's whole lifecycle —
 * ready, start, steps, manual, done, crash — without spawning a Node process or
 * waiting on a real clock.
 *
 * **The behaviour is scripted per test, not derived from the items.** The real
 * worker's fake driver reads a credential to decide what to do, which is right
 * for an end-to-end test where the only channel to the child is a text line; here
 * the test *is* the caller, so it says directly what should happen. The end-to-end
 * suite covers the real thing by spawning the real worker.
 *
 * Every frame the manager sends is recorded, so a test can assert what the host
 * told the worker as well as what the worker told the host — the two halves of
 * "the host owns the deadline" are the deadline being set and the `abandon-item`
 * being sent.
 */

/**
 * What the scripted worker does with one item.
 *
 * `hang` is the one that matters for pause: it reports a step and then never
 * reports anything else, so the item stays in flight and a test can interrupt
 * something that is genuinely mid-air.
 */
export type WorkerAction = 'done' | 'failed' | 'manual' | 'hang';

/** What the scripted worker does when the manager starts it. */
export interface WorkerScript {
  /**
   * Announcing itself. Off is a worker that never becomes ready, which is the
   * case the readiness clock exists for.
   */
  readonly ready?: boolean;
  /**
   * What to do with each item, **by position**.
   *
   * By position rather than by id because the manager generates the ids — a test
   * cannot know them before the job exists. Position is also what the batch
   * preserves, so "the second credential failed" is a fact a test can state.
   *
   * An item past the end of this list is left alone, which is how a test models a
   * worker that died part-way through.
   */
  readonly items?: readonly WorkerAction[];
  /** Emit `done` once every scripted item has been reported. */
  readonly finish?: boolean;
  /** Emit a job-level `failed` immediately instead of walking anything. */
  readonly jobFails?: string;
  /**
   * Never emit anything after `ready`. The job simply hangs.
   *
   * Distinct from `ready: false`: this worker announced itself and then went
   * quiet, which is the stall FR-5.10 is about. `ready: false` is a worker that
   * never started at all, which is a different failure with a different clock.
   */
  readonly silent?: boolean;
}

export interface FakeWorker {
  readonly launcher: WorkerLauncher;
  /** Every frame the manager sent, in order. */
  readonly sent: HostToWorker[];
  /** The job the manager handed over, once it has. */
  job(): WorkerJob | null;
  /** Whether the manager asked the worker to stop. */
  killed(): boolean;
  /** End the process as a crash, the way an OOM or a kill from outside would. */
  crash(code?: number): void;
  /** Emit a frame the manager did not ask for — a late one, or an extra step. */
  emit(message: WorkerToHost): void;
  /** The handle for the most recent launch. */
  handle(): WorkerHandle | null;
}

export function createFakeWorker(script: WorkerScript = {}): FakeWorker {
  const sent: HostToWorker[] = [];
  let current: WorkerHandle | null = null;
  let job: WorkerJob | null = null;
  let killed = false;
  let messageHandler: ((message: WorkerToHost) => void) | null = null;
  let exitHandler: ((code: number | null, signal: string | null) => void) | null = null;

  const emit = (message: WorkerToHost): void => {
    messageHandler?.(message);
  };

  const workerIdOf = (): string => job?.jobId ?? 'worker';

  const launcher: WorkerLauncher = {
    launch(workerId): WorkerHandle {
      killed = false;
      job = null;

      const handle: WorkerHandle = {
        id: workerId,
        send(message: HostToWorker): void {
          sent.push(message);
          if (message.type === 'start') {
            job = message.job;
            // The walk starts on the next tick, so the manager's own `publish`
            // for the running status has already happened — which is the order a
            // real worker's frames arrive in.
            queueMicrotask(() => {
              walk(message.job);
            });
            return;
          }
          if (message.type === 'manual-answer') {
            const itemId = message.itemId;
            const solution = message.solution;
            const label = job?.items.find((item) => item.id === itemId)?.label ?? itemId;
            queueMicrotask(() => {
              emit({
                type: 'step',
                workerId: workerIdOf(),
                itemId,
                index: 1,
                name: 'challenge',
                status: 'ok',
                detail: `answered with "${solution}"`,
              });
              emit({
                type: 'item-done',
                workerId: workerIdOf(),
                itemId,
                credential: `answer:${solution}`,
                label,
              });
            });
            return;
          }
          if (message.type === 'abandon-item') {
            // The real worker reports the abandonment; the manager has already
            // marked the item failed by the time this arrives, and `afterItem`
            // is what closes the job out.
            return;
          }
          if (message.type === 'cancel' || message.type === 'shutdown') {
            killed = true;
          }
        },
        kill(): void {
          killed = true;
          exitHandler?.(null, 'SIGKILL');
        },
        onMessage(handler): void {
          messageHandler = handler;
        },
        onExit(handler): void {
          exitHandler = handler;
        },
      };

      current = handle;
      if (script.ready !== false) {
        queueMicrotask(() => {
          emit({ type: 'ready', workerId });
        });
      }
      return handle;
    },
  };

  function walk(started: WorkerJob): void {
    if (script.silent === true) return;
    if (script.jobFails !== undefined) {
      emit({ type: 'failed', workerId: started.jobId, error: script.jobFails, retryable: false });
      return;
    }

    for (const [position, item] of started.items.entries()) {
      const action = script.items?.[position];
      if (action === undefined) continue;

      emit({
        type: 'step',
        workerId: started.jobId,
        itemId: item.id,
        index: 0,
        name: 'open',
        status: 'ok',
        detail: null,
      });

      if (action === 'hang') {
        // The item is in flight and stays there: the walk stops and nothing more
        // is reported, which is what a pause or a crash has to interrupt.
        return;
      }

      if (action === 'done') {
        emit({
          type: 'item-done',
          workerId: started.jobId,
          itemId: item.id,
          credential: `fake:${item.id}`,
          label: item.label,
        });
        continue;
      }
      if (action === 'failed') {
        emit({
          type: 'item-failed',
          workerId: started.jobId,
          itemId: item.id,
          error: 'the provider refused this credential',
          attempts: 1,
        });
        continue;
      }
      emit({
        type: 'needs-manual',
        workerId: started.jobId,
        itemId: item.id,
        reason: 'image challenge',
        screenshotUrl: 'data:image/jpeg;base64,AAAA',
        humanTimeoutSeconds: 180,
      });
      // A parked item stops the walk: the real worker is blocked on it too.
      return;
    }

    if (script.finish !== false) emit({ type: 'done', workerId: started.jobId });
  }

  return {
    launcher,
    sent,
    job: () => job,
    killed: () => killed,
    crash: (code = 1) => {
      exitHandler?.(code, null);
    },
    emit,
    handle: () => current,
  };
}

/**
 * Clocks a test fires by hand.
 *
 * A manual deadline is measured in minutes in production, so a test that waits it
 * out is a test that takes minutes. Each `after` is recorded with its delay and
 * the callback is returned, so a test can assert the interval *and* fire it.
 */
export interface ManualClock {
  readonly timers: { after(ms: number, fn: () => void): () => void };
  /** Every delay asked for, in order, whether or not it is still pending. */
  readonly delays: number[];
  /**
   * Fire a pending timer by the interval it was armed with.
   *
   * By interval rather than by position, because a job arms several clocks and
   * the position of any one of them moves as the others fire and re-arm. "Fire
   * the five-minute clock" is what a test means; "fire the second pending one" is
   * a fact about an implementation the test should not have to know.
   */
  fire(ms: number): void;
  /** How many callbacks are still pending. */
  pending(): number;
}

export function manualClock(): ManualClock {
  const entries: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  const delays: number[] = [];

  return {
    timers: {
      after(ms, fn) {
        delays.push(ms);
        const entry = { ms, fn, cancelled: false };
        entries.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    },
    delays,
    fire(ms) {
      const target = entries.find((entry) => !entry.cancelled && entry.ms === ms);
      if (target === undefined) throw new Error(`no pending timer armed at ${String(ms)}ms`);
      target.cancelled = true;
      target.fn();
    },
    pending() {
      return entries.filter((entry) => !entry.cancelled).length;
    },
  };
}
