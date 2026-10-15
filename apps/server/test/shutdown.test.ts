import { describe, expect, it } from 'vitest';

import { Lifecycle } from '@server/runtime/lifecycle.ts';
import {
  createShutdown,
  type ShutdownDeps,
  type ShutdownInterval,
} from '@server/runtime/shutdown.ts';
import { silentLogger } from '@server/observability/logger.ts';

/**
 * The shutdown order (D2).
 *
 * This file exists because of a bug. In D1, a warmup sweep still in flight read
 * the database after `persistence.close()` had run underneath it, and the result
 * was `RangeError: Cannot use a closed database` thrown from a timer nothing was
 * watching — an unhandled rejection that vitest reported as a possible source of
 * false positives. The order in `main()` was already correct at that point;
 * **nothing was pinning it**, and the block lived inside an unexported 470-line
 * function that no test could reach.
 *
 * So the subject here is the sequence, and the assertions are about order rather
 * than about what each step does. A `Shutdown` that stops everything but in the
 * wrong order is exactly the bug that happened.
 *
 * Every dependency is a recorder, so the test observes the real order instead of
 * asserting that a set of mocks was called. `exit` is captured rather than
 * called: `process.exit(0)` is right in production and would take the test runner
 * with it here, which is why it is injected at all.
 */

interface Recorder {
  readonly calls: string[];
  readonly deps: Omit<ShutdownDeps, 'logger' | 'lifecycle' | 'exit'>;
  readonly lifecycle: Lifecycle;
  readonly exited: number[];
}

function recorder(options: { drainTimeoutMs?: number; hangServer?: boolean } = {}): Recorder {
  const calls: string[] = [];
  const lifecycle = new Lifecycle();
  lifecycle.markReady();

  const note = (name: string): void => {
    calls.push(name);
  };

  // Real handles, so `clearInterval` is called on something genuine and the test
  // would fail loudly if the module stopped clearing them.
  const handles: ReturnType<typeof setInterval>[] = [
    setInterval(() => undefined, 1_000_000),
    setInterval(() => undefined, 1_000_000),
  ];
  const intervals: readonly ShutdownInterval[] = [
    { name: 'first', handle: handles[0] as ReturnType<typeof setInterval> },
    { name: 'second', handle: handles[1] as ReturnType<typeof setInterval> },
  ];

  return {
    calls,
    lifecycle,
    exited: [],
    deps: {
      intervals,
      logPush: {
        stop: () => {
          note('logPush.stop');
        },
      },
      warmup: {
        stop: () => {
          note('warmup.stop');
        },
      },
      jobs: {
        shutdown: () => {
          note('jobs.shutdown');
        },
      },
      hub: {
        closeAll: () => {
          note('hub.closeAll');
        },
      },
      server: {
        stop: () => {
          note('server.stop');
          // A stop that never settles is what the drain ceiling is for.
          return options.hangServer === true ? new Promise<void>(() => undefined) : undefined;
        },
      },
      providerOauth: {
        stop: () => {
          note('providerOauth.stop');
        },
      },
      persistence: {
        close: () => {
          note('persistence.close');
        },
      },
      drainTimeoutMs: options.drainTimeoutMs ?? 10_000,
    },
  };
}

function build(r: Recorder): { shutdown: (signal: string) => Promise<void> } {
  return {
    shutdown: createShutdown({
      logger: silentLogger(),
      lifecycle: r.lifecycle,
      ...r.deps,
      exit: (code) => {
        r.exited.push(code);
      },
    }),
  };
}

describe('the shutdown order', () => {
  it('stops everything that reaches for the database before closing it', async () => {
    const r = recorder();
    const { shutdown } = build(r);

    await shutdown('SIGTERM');

    // The invariant, and the one the D1 bug violated. Everything that holds a
    // timer or reads the database has to have finished before the handle goes.
    const closed = r.calls.indexOf('persistence.close');
    expect(closed).toBeGreaterThan(-1);
    for (const before of ['logPush.stop', 'warmup.stop', 'jobs.shutdown', 'hub.closeAll']) {
      expect(r.calls.indexOf(before), `${before} ran after persistence.close()`).toBeLessThan(
        closed,
      );
    }
  });

  it('runs the whole sequence in the order it was designed in', async () => {
    const r = recorder();
    const { shutdown } = build(r);

    await shutdown('SIGTERM');

    // Written out in full rather than spot-checked, because "the order" is the
    // entire subject of the file — a spot check would pass while two adjacent
    // steps had swapped.
    expect(r.calls).toEqual([
      'logPush.stop',
      'warmup.stop',
      'jobs.shutdown',
      'hub.closeAll',
      'server.stop',
      // Reversed by `runShutdownHooks` (last-registered-first), which is why
      // `persistence.close` lands before `providerOauth.stop` even though
      // `main.ts` registers them the other way round. See `shutdown.ts`.
      'persistence.close',
      'providerOauth.stop',
    ]);
  });

  it('refuses new work before it stops anything', async () => {
    const r = recorder();
    const { shutdown } = build(r);

    await shutdown('SIGTERM');

    // `beginDrain` is not in the call list — it is on the real `Lifecycle`, so
    // the state it sets is the observable.
    expect(r.lifecycle.state).toBe('stopped');
    expect(r.lifecycle.acceptingRequests).toBe(false);
  });

  it('closes the sockets before asking the server to stop', async () => {
    const r = recorder();
    const { shutdown } = build(r);

    await shutdown('SIGTERM');

    // A stop that waits for open connections waits the whole drain timeout, and
    // WebSocket clients are exactly the connections that never close on their
    // own — so this ordering is what keeps a shutdown from taking ten seconds.
    expect(r.calls.indexOf('hub.closeAll')).toBeLessThan(r.calls.indexOf('server.stop'));
  });

  it('does the whole thing once, whatever signals arrive', async () => {
    const r = recorder();
    const { shutdown } = build(r);

    // An operator who sends a second signal is impatient, not instructing.
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(r.calls.filter((call) => call === 'persistence.close')).toHaveLength(1);
    expect(r.calls.filter((call) => call === 'jobs.shutdown')).toHaveLength(1);
    expect(r.exited).toEqual([0]);
  });

  it('finishes anyway when the server never stops', async () => {
    // The drain ceiling. Without the race, a server whose `stop()` never settles
    // holds the process open forever and the supervisor has to SIGKILL it — which
    // is the outcome the graceful path exists to avoid.
    const r = recorder({ drainTimeoutMs: 20, hangServer: true });
    const { shutdown } = build(r);

    await shutdown('SIGTERM');

    expect(r.calls).toContain('persistence.close');
    expect(r.lifecycle.state).toBe('stopped');
    expect(r.exited).toEqual([0]);
  });

  it('still releases the database when a shutdown hook throws', async () => {
    // `runShutdownHooks` reports failures rather than throwing, so one resource
    // that will not close cannot stop the others. The hook that throws here is
    // registered first, which under the reversal means it runs last.
    const r = recorder();
    r.lifecycle.onShutdown(() => {
      throw new Error('this hook is broken');
    });
    const { shutdown } = build(r);

    await shutdown('SIGTERM');

    expect(r.calls).toContain('persistence.close');
    expect(r.lifecycle.state).toBe('stopped');
  });
});
