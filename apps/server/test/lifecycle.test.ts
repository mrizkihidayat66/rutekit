import { describe, expect, it } from 'vitest';

import { Lifecycle } from '@server/runtime/lifecycle.ts';

/**
 * Boot and drain state (C1.2).
 *
 * The two questions this answers — "alive?" and "taking work?" — have different
 * answers during a drain, and conflating them is what makes a supervisor restart
 * a healthy process that is merely shutting down (A23).
 */

describe('Lifecycle', () => {
  it('starts in `starting`, refusing new work', () => {
    const lifecycle = new Lifecycle();

    expect(lifecycle.state).toBe('starting');
    expect(lifecycle.acceptingRequests).toBe(false);
  });

  it('accepts work once marked ready', () => {
    const lifecycle = new Lifecycle();
    lifecycle.markReady();

    expect(lifecycle.state).toBe('ready');
    expect(lifecycle.acceptingRequests).toBe(true);
  });

  it('stops accepting the moment the drain begins', () => {
    const lifecycle = new Lifecycle();
    lifecycle.markReady();
    lifecycle.beginDrain();

    expect(lifecycle.state).toBe('draining');
    expect(lifecycle.acceptingRequests).toBe(false);
  });

  it('lets a drain begin from `starting` as well as from `ready`', () => {
    // A signal during boot must still land somewhere that is not `ready`.
    const lifecycle = new Lifecycle();
    lifecycle.beginDrain();
    expect(lifecycle.state).toBe('draining');
  });

  it('cannot be drained a second time once stopped', () => {
    // `beginDrain` only moves forward from `starting` or `ready`; a stopped
    // process has nowhere left to go.
    const lifecycle = new Lifecycle();
    lifecycle.markReady();
    lifecycle.beginDrain();
    lifecycle.markStopped();
    lifecycle.beginDrain();

    expect(lifecycle.state).toBe('stopped');
  });

  it('reports a non-negative uptime', () => {
    expect(new Lifecycle().uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('runs shutdown hooks last-registered-first', async () => {
    // So a later resource is closed before the one it depends on.
    const order: string[] = [];
    const lifecycle = new Lifecycle();
    lifecycle.onShutdown(() => {
      order.push('first');
    });
    lifecycle.onShutdown(() => {
      order.push('second');
    });

    await lifecycle.runShutdownHooks();
    expect(order).toEqual(['second', 'first']);
  });

  it('reports a failing hook without stopping the rest', async () => {
    // One resource that will not close must not keep the others from being
    // released, or a single bad hook hangs the whole shutdown.
    const order: string[] = [];
    const lifecycle = new Lifecycle();
    lifecycle.onShutdown(() => {
      order.push('a');
    });
    lifecycle.onShutdown(() => {
      throw new Error('hook b failed');
    });
    lifecycle.onShutdown(() => {
      order.push('c');
    });

    const failures = await lifecycle.runShutdownHooks();

    expect(order).toEqual(['c', 'a']);
    expect(failures).toHaveLength(1);
  });

  it('awaits async hooks', async () => {
    const order: string[] = [];
    const lifecycle = new Lifecycle();
    lifecycle.onShutdown(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push('slow');
    });

    await lifecycle.runShutdownHooks();
    expect(order).toEqual(['slow']);
  });

  it('runs each hook once, even across two shutdown passes', async () => {
    let runs = 0;
    const lifecycle = new Lifecycle();
    lifecycle.onShutdown(() => {
      runs += 1;
    });

    await lifecycle.runShutdownHooks();
    await lifecycle.runShutdownHooks();
    expect(runs).toBe(1);
  });
});
