/**
 * Boot and drain state for the process.
 *
 * Two questions are answered separately, because they have different answers:
 * "is this process alive?" (`/healthz`, always yes until it exits) and "should
 * this process take new work?" (`/readyz`, no while starting and no once
 * draining). Collapsing them means a supervisor either restarts a healthy
 * process that is merely shutting down, or keeps sending traffic to one that
 * has already stopped accepting it (A23, NFR-8).
 */

export type LifecycleState = 'starting' | 'ready' | 'draining' | 'stopped';

/** A teardown step: close the server, flush the database, kill the worker pool. */
export type ShutdownHook = () => void | Promise<void>;

export class Lifecycle {
  #state: LifecycleState = 'starting';
  #hooks: ShutdownHook[] = [];
  readonly #startedAtMs = Date.now();

  get state(): LifecycleState {
    return this.#state;
  }

  get startedAtMs(): number {
    return this.#startedAtMs;
  }

  get uptimeSeconds(): number {
    return Math.max(0, Math.floor((Date.now() - this.#startedAtMs) / 1000));
  }

  /** False while starting and once draining, so the readiness gate can refuse. */
  get acceptingRequests(): boolean {
    return this.#state === 'ready';
  }

  markReady(): void {
    this.#state = 'ready';
  }

  beginDrain(): void {
    if (this.#state === 'ready' || this.#state === 'starting') this.#state = 'draining';
  }

  markStopped(): void {
    this.#state = 'stopped';
  }

  /** Hooks run last-registered-first, so a later resource is closed before its dependency. */
  onShutdown(hook: ShutdownHook): void {
    this.#hooks.push(hook);
  }

  /**
   * Run every hook and report the failures rather than throwing: one resource
   * that will not close must not stop the others from being released. The
   * caller logs whatever comes back.
   */
  async runShutdownHooks(): Promise<readonly unknown[]> {
    const hooks = [...this.#hooks].reverse();
    this.#hooks = [];
    const failures: unknown[] = [];
    for (const hook of hooks) {
      try {
        await hook();
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  }
}
