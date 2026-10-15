import { describe, expect, it } from 'vitest';
import type { WorkerItem, WorkerJob, WorkerToHost } from '@rutekit/contracts';

import { RetryableError, type BrowserDriver } from '../src/driver.ts';
import { createFakeDriver } from '../src/drivers/fake.ts';
import { JobRunner } from '../src/flow.ts';

/**
 * Running a batch (C7b, FR-5.6, FR-5.12).
 *
 * The runner is driven directly rather than over stdio, because what is under
 * test here is the *policy* — how many attempts a failure gets, what a manual
 * hand-off does, what an abandonment costs — and a policy is easier to read when
 * the frames are a list in memory than when they arrive on a pipe. The pipe
 * itself is covered by the server's integration test, which spawns the real
 * process.
 *
 * The fake driver's vocabulary is what scripts these cases: an item whose
 * credential says `flaky` fails retryably once, `refuse` fails for good, `manual`
 * asks a human. See `drivers/fake.ts`.
 */

/** Collects the frames a run emits, so a test can assert on the whole sequence. */
function collector(): { emit: (message: WorkerToHost) => void; frames: WorkerToHost[] } {
  const frames: WorkerToHost[] = [];
  return { frames, emit: (message) => frames.push(message) };
}

function item(id: string, credential: string): WorkerItem {
  return { id, label: `${id}***@example.com`, credential };
}

function job(items: readonly WorkerItem[], overrides: Partial<WorkerJob> = {}): WorkerJob {
  return {
    jobId: 'job-1',
    providerId: 'kiro',
    method: 'bulk-login',
    engine: 'chromium',
    mode: 'headless',
    concurrency: 1,
    maxAttempts: 3,
    automation: null,
    proxy: null,
    sms: null,
    items: [...items],
    ...overrides,
  };
}

/** A runner whose backoff costs nothing, so a retry test is not a two-second test. */
function runnerFor(
  spec: WorkerJob,
  options: { frames: WorkerToHost[]; emit: (m: WorkerToHost) => void; sleeps?: number[] },
): JobRunner {
  return new JobRunner({
    job: spec,
    driver: createFakeDriver({ slowMs: 10 }),
    emit: options.emit,
    sleep: (ms) => {
      options.sleeps?.push(ms);
      return Promise.resolve();
    },
  });
}

function typesOf(frames: readonly WorkerToHost[]): string[] {
  return frames.map((frame) => frame.type);
}

/** A runner over an arbitrary driver, for the cases the fake driver cannot script. */
class Runner {
  readonly #runner: JobRunner;
  constructor(driver: BrowserDriver, spec: WorkerJob, emit: (m: WorkerToHost) => void, sleeps: number[]) {
    this.#runner = new JobRunner({
      job: spec,
      driver,
      emit,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
  }
  run(): Promise<void> {
    return this.#runner.run();
  }
  handle(message: Parameters<JobRunner['handle']>[0]): void {
    this.#runner.handle(message);
  }
}

function forItem(frames: readonly WorkerToHost[], itemId: string): WorkerToHost[] {
  return frames.filter((frame) => 'itemId' in frame && frame.itemId === itemId);
}

describe('a batch that goes well', () => {
  it('imports every item and reports the job done', async () => {
    const { frames, emit } = collector();
    await runnerFor(job([item('a', 'plain:x'), item('b', 'plain:y')]), { frames, emit }).run();

    const done = frames.filter((frame) => frame.type === 'item-done');
    expect(done.map((frame) => frame.itemId)).toEqual(['a', 'b']);
    expect(typesOf(frames).at(-1)).toBe('done');
  });

  it('carries the credential the driver produced', async () => {
    const { frames, emit } = collector();
    await runnerFor(job([item('a', 'plain:x')]), { frames, emit }).run();

    const done = frames.find((frame) => frame.type === 'item-done');
    expect(done?.type).toBe('item-done');
    if (done?.type !== 'item-done') return;
    // The credential is the whole point of the job, and it is the one credential
    // that travels from the worker to the host.
    expect(done.credential).toBe('fake-credential:a');
    expect(done.label).toBe('a***@example.com');
  });

  it('numbers the steps of an item from one, in order', async () => {
    const { frames, emit } = collector();
    await runnerFor(job([item('a', 'plain:x')]), { frames, emit }).run();

    const steps = forItem(frames, 'a').filter((frame) => frame.type === 'step');
    expect(steps.map((frame) => (frame.type === 'step' ? frame.index : -1))).toEqual(
      steps.map((_frame, index) => index + 1),
    );
  });

  it('finishes an empty batch immediately', async () => {
    const { frames, emit } = collector();
    await runnerFor(job([]), { frames, emit }).run();

    expect(typesOf(frames)).toEqual(['done']);
  });
});

/**
 * A driver that always fails in a way the flow may retry.
 *
 * `flaky` in the fake driver fails exactly once, which is what makes "retry
 * succeeds" assertable — but it cannot exercise the backoff *sequence*, because
 * there is only ever one wait. This one never succeeds, so every attempt but the
 * last produces a wait.
 */
function alwaysRetryable(): { driver: BrowserDriver; attempts: () => number } {
  let attempts = 0;
  return {
    attempts: () => attempts,
    driver: {
      name: 'always-retryable',
      importItem: () => {
        attempts += 1;
        return Promise.reject(new RetryableError('still not settling'));
      },
      close: () => Promise.resolve(),
    },
  };
}

describe('retrying a failure', () => {
  it('tries a retryable failure again and reports the success', async () => {
    const { frames, emit } = collector();
    await runnerFor(job([item('a', 'flaky:x')]), { frames, emit }).run();

    // `flaky` fails its first attempt, so the item ends up imported on the second.
    expect(frames.filter((frame) => frame.type === 'item-done')).toHaveLength(1);
    expect(frames.filter((frame) => frame.type === 'item-failed')).toHaveLength(0);
  });

  it('waits base 2s doubling per attempt, capped at 15s (FR-5.6)', async () => {
    const { emit } = collector();
    const sleeps: number[] = [];
    const failing = alwaysRetryable();

    // Six attempts, so five waits — which is where the doubling outgrows the cap.
    await new Runner(failing.driver, job([item('a', 'x')], { maxAttempts: 6 }), emit, sleeps).run();

    // 2, 4, 8, then the cap: 16 would be next and 32 after it.
    expect(sleeps).toEqual([2_000, 4_000, 8_000, 15_000, 15_000]);
  });

  it('spends exactly maxAttempts before giving up', async () => {
    const { frames, emit } = collector();
    const failing = alwaysRetryable();

    await new Runner(failing.driver, job([item('a', 'x')], { maxAttempts: 3 }), emit, []).run();

    expect(failing.attempts()).toBe(3);
    const failed = frames.find((frame) => frame.type === 'item-failed');
    expect(failed?.type).toBe('item-failed');
    if (failed?.type !== 'item-failed') return;
    expect(failed.attempts).toBe(3);
  });

  it('does not retry a failure the driver did not mark retryable', async () => {
    const { frames, emit } = collector();
    const sleeps: number[] = [];
    await runnerFor(job([item('a', 'refuse:x')]), { frames, emit, sleeps }).run();

    const failed = frames.filter((frame) => frame.type === 'item-failed');
    expect(failed).toHaveLength(1);
    if (failed[0]?.type !== 'item-failed') return;
    // One attempt, no wait: a credential the provider rejected is rejected again,
    // and spending an attempt on it costs a slot for nothing.
    expect(failed[0].attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });
});

describe('a challenge handed to a human', () => {
  it('reports the challenge and waits', async () => {
    const { frames, emit } = collector();
    const runner = runnerFor(job([item('a', 'manual:x')]), { frames, emit });

    const running = runner.run();
    await settle();

    const needsManual = frames.find((frame) => frame.type === 'needs-manual');
    expect(needsManual?.type).toBe('needs-manual');
    if (needsManual?.type !== 'needs-manual') return;
    expect(needsManual.itemId).toBe('a');
    expect(needsManual.reason).toBe('image challenge');
    // The screenshot is what the operator looks at, so it travels with the ask.
    expect(needsManual.screenshotUrl).toContain('data:image/jpeg');

    // Nothing finishes until somebody answers.
    expect(frames.filter((frame) => frame.type === 'item-done')).toHaveLength(0);

    runner.handle({ type: 'manual-answer', workerId: 'job-1', itemId: 'a', solution: 'AB12C' });
    await running;

    expect(frames.filter((frame) => frame.type === 'item-done')).toHaveLength(1);
  });

  it('abandons the item when the deadline passes, and does not spend a retry', async () => {
    const { frames, emit } = collector();
    const runner = runnerFor(job([item('a', 'manual:x')]), { frames, emit });

    const running = runner.run();
    await settle();

    runner.handle({ type: 'abandon-item', workerId: 'job-1', itemId: 'a' });
    await running;

    const failed = frames.find((frame) => frame.type === 'item-failed');
    expect(failed?.type).toBe('item-failed');
    if (failed?.type !== 'item-failed') return;
    // The operator ran out of time, not the attempt — so this is not a retry.
    expect(failed.attempts).toBe(1);
    expect(failed.error).toContain('deadline');
    expect(frames.filter((frame) => frame.type === 'item-done')).toHaveLength(0);
  });

  it('carries on with the rest of the batch after an abandonment', async () => {
    const { frames, emit } = collector();
    const runner = runnerFor(job([item('a', 'manual:x'), item('b', 'plain:y')]), { frames, emit });

    const running = runner.run();
    await settle();
    runner.handle({ type: 'abandon-item', workerId: 'job-1', itemId: 'a' });
    await running;

    // One item lost, one imported, and the job still finishes.
    expect(frames.filter((frame) => frame.type === 'item-failed')).toHaveLength(1);
    expect(frames.filter((frame) => frame.type === 'item-done')).toHaveLength(1);
    expect(typesOf(frames).at(-1)).toBe('done');
  });

  it('ignores an answer to an item that has already moved on', async () => {
    const { frames, emit } = collector();
    const runner = runnerFor(job([item('a', 'plain:x')]), { frames, emit });
    await runner.run();

    // The operator's text arrives after the item landed. It belongs to nothing,
    // and acting on it would be answering a question nobody is asking.
    expect(() => {
      runner.handle({ type: 'manual-answer', workerId: 'job-1', itemId: 'a', solution: 'late' });
    }).not.toThrow();
  });
});

describe('stopping a batch', () => {
  it('reports the running item as stopped rather than imported', async () => {
    const { frames, emit } = collector();
    const runner = runnerFor(job([item('a', 'slow:x')]), { frames, emit });

    const running = runner.run();
    await settle();
    runner.handle({ type: 'cancel', workerId: 'job-1' });
    await running;

    // `slow` is what gives the cancellation something to interrupt.
    expect(frames.filter((frame) => frame.type === 'item-done')).toHaveLength(0);
    expect(frames.filter((frame) => frame.type === 'item-failed')).toHaveLength(1);
  });

  it('starts no further items once stopped', async () => {
    const { frames, emit } = collector();
    const runner = runnerFor(
      job([item('a', 'slow:x'), item('b', 'plain:y'), item('c', 'plain:z')]),
      { frames, emit },
    );

    const running = runner.run();
    await settle();
    runner.handle({ type: 'cancel', workerId: 'job-1' });
    await running;

    // Only the item that was already in flight is accounted for; the two behind
    // it never started, which is what makes them safe to re-queue.
    const touched = new Set(
      frames.filter((frame) => 'itemId' in frame).map((frame) => frame.itemId),
    );
    expect(touched.size).toBeLessThanOrEqual(2);
  });

  it('treats a shutdown the same way as a cancel', async () => {
    const { frames, emit } = collector();
    const runner = runnerFor(job([item('a', 'slow:x')]), { frames, emit });

    const running = runner.run();
    await settle();
    runner.handle({ type: 'shutdown', workerId: 'job-1' });
    await running;

    expect(frames.filter((frame) => frame.type === 'item-done')).toHaveLength(0);
  });
});

describe('concurrency', () => {
  it('runs up to the job’s limit at once', async () => {
    const { frames, emit } = collector();
    const inFlight = new Set<string>();
    let peak = 0;

    // A driver that records how many items are open at the same moment, which is
    // the only way to assert the limit without timing anything.
    const counting = {
      name: 'counting',
      importItem: async (context: { item: WorkerItem }) => {
        inFlight.add(context.item.id);
        peak = Math.max(peak, inFlight.size);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight.delete(context.item.id);
        return { credential: 'c', label: context.item.label };
      },
      close: () => Promise.resolve(),
    };

    const runner = new JobRunner({
      job: job(
        [item('a', 'x'), item('b', 'x'), item('c', 'x'), item('d', 'x')],
        { concurrency: 2 },
      ),
      driver: counting,
      emit,
      sleep: () => Promise.resolve(),
    });
    await runner.run();

    expect(peak).toBe(2);
    expect(frames.filter((frame) => frame.type === 'item-done')).toHaveLength(4);
  });

  it('never asks for more workers than there are items', async () => {
    const { frames, emit } = collector();
    // One item and a concurrency of ten would otherwise spawn ten loops, nine of
    // which immediately find an empty queue.
    await runnerFor(job([item('a', 'plain:x')], { concurrency: 10 }), { frames, emit }).run();

    expect(frames.filter((frame) => frame.type === 'item-done')).toHaveLength(1);
  });
});

/** Let the microtask queue drain, so a run reaches its first await. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
