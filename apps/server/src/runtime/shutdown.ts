import type { Logger } from 'pino';

import type { Lifecycle } from './lifecycle.ts';

/**
 * Taking the process down in the right order (D2).
 *
 * This was a block inside `main()` — an unexported, 470-line function that no
 * test could reach. It is pulled out for one reason, and the reason is a bug:
 * in D1, a warmup sweep that was still in flight kept reading the database after
 * `persistence.close()` had run underneath it, and the result was
 * `RangeError: Cannot use a closed database` thrown from a timer nothing was
 * watching. The order was already correct by then; **nothing was pinning it**, so
 * a plausible-looking edit could break it again and the only symptom would be an
 * unhandled rejection nobody had a listener for.
 *
 * So the order is the subject of this file, and it is worth stating what each
 * step is for:
 *
 *   1. **Refuse new work first.** `beginDrain()` flips the readiness gate, so a
 *      request that arrives mid-teardown is a `503 shutting_down` rather than
 *      something that races the shutdown. Doing this before anything is stopped
 *      is what makes the window between "stopping" and "stopped" legible.
 *   2. **Stop periodic work.** Every interval, plus the log subscription. None of
 *      it should fire while the things it reaches for are being taken apart.
 *   3. **Stop the warmup.** It is the one periodic worker that holds a *network*
 *      round trip and reads the database on both sides of it, so it is the one
 *      that can still be mid-probe here. See `pool/warmup.ts` for the generation
 *      counter this relies on.
 *   4. **Kill the workers.** A browser left running after the gateway is gone
 *      holds a socket, an account slot, and a display nobody is looking at.
 *   5. **Close the sockets.** Before `server.stop()`, because a stop that waits
 *      for open connections would wait the whole drain timeout — the WebSocket
 *      clients are exactly the connections that never close on their own.
 *   6. **Stop the server, with a ceiling.** A drain that hangs must not hang the
 *      process; the race is what makes the timeout a real deadline.
 *   7. **Run the shutdown hooks**, then mark the process stopped.
 *
 * **Everything that holds a timer or reaches for the database is finished before
 * `persistence.close()`.** That is the property the test in
 * `apps/server/test/shutdown.test.ts` asserts, and it is the only reason this
 * file exists.
 *
 * One thing about the hooks is worth reading twice, because the code suggests the
 * opposite of what happens. `Lifecycle.runShutdownHooks` runs them
 * **last-registered-first**, so registering `providerOauth` and then `persistence`
 * means `persistence.close()` runs *first* — the reverse of how the two lines
 * read. It is harmless here: `providerOauth.stop()` clears timers and touches no
 * database, so neither order is wrong. It is stated rather than left implicit
 * because the next hook added may not be so indifferent, and the registration
 * order is not the order it will run in.
 *
 * `exit` is injected rather than called directly. `process.exit(0)` at the end is
 * correct in production and catastrophic in a test — it would take the test
 * runner with it — so the one thing that must not be hard-coded is the one thing
 * that leaves the process.
 */

/** One periodic handle the process holds, named so a log line can say which. */
export interface ShutdownInterval {
  readonly name: string;
  readonly handle: ReturnType<typeof setInterval>;
}

export interface ShutdownDeps {
  readonly logger: Logger;
  readonly lifecycle: Lifecycle;
  /** Every interval the process holds. All are cleared before anything is awaited. */
  readonly intervals: readonly ShutdownInterval[];
  /** The console log ring's subscription, which is a push rather than a poll. */
  readonly logPush: { stop(): void };
  readonly warmup: { stop(): void };
  readonly jobs: { shutdown(): void };
  readonly hub: { closeAll(): void };
  readonly server: { stop(): Promise<void> | void };
  readonly providerOauth: { stop(): void };
  readonly persistence: { close(): void };
  /** How long a drain may take before in-flight work is abandoned. */
  readonly drainTimeoutMs: number;
  /** The way out. Injected so a test does not end the process it runs in. */
  readonly exit: (code: number) => void;
  /** The drain deadline's clock, injectable so a test does not wait it out. */
  readonly setTimeoutFn?: (handler: () => void, ms: number) => unknown;
}

export type Shutdown = (signal: string) => Promise<void>;

export function createShutdown(deps: ShutdownDeps): Shutdown {
  const schedule = deps.setTimeoutFn ?? setTimeout;
  let draining = false;

  return async function shutdown(signal: string): Promise<void> {
    // A second signal during a drain is not a reason to do any of this twice —
    // the `SIGINT` that follows a `SIGTERM` is an operator being impatient, not
    // a new instruction. It also means the handlers below cannot interleave.
    if (draining) return;
    draining = true;

    deps.logger.info({ signal }, 'draining');
    deps.lifecycle.beginDrain();

    for (const { name, handle } of deps.intervals) {
      clearInterval(handle);
      deps.logger.debug({ interval: name }, 'periodic work stopped');
    }
    deps.logPush.stop();
    deps.warmup.stop();
    deps.jobs.shutdown();
    deps.hub.closeAll();

    await Promise.race([
      Promise.resolve(deps.server.stop()),
      new Promise((resolve) => {
        // A thunk rather than `resolve` itself: the injected timer is typed to
        // take no arguments, and a resolver that receives one is a different
        // signature.
        schedule(() => {
          resolve(undefined);
        }, deps.drainTimeoutMs);
      }),
    ]);

    // Registered here rather than at boot, which is what the original did: a
    // process that never shuts down never registers them, and there is no reason
    // for them to exist before they are about to run.
    deps.lifecycle.onShutdown(() => deps.providerOauth.stop());
    deps.lifecycle.onShutdown(() => deps.persistence.close());

    for (const failure of await deps.lifecycle.runShutdownHooks()) {
      deps.logger.error({ err: failure }, 'shutdown hook failed');
    }

    deps.lifecycle.markStopped();
    deps.logger.info('stopped');
    deps.exit(0);
  };
}
