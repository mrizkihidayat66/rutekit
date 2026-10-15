import { Hono } from 'hono';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';

import { AbuseGuard, abuseGuard } from '@server/ingress/abuse.ts';
import { errorLifecycle } from '@server/ingress/error-lifecycle.ts';
import { requestContext } from '@server/ingress/request-context.ts';
import { silentLogger } from '@server/observability/logger.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The per-address ceiling (C1.4).
 *
 * The clock is injected everywhere, so a window can be advanced by a number
 * rather than by sleeping. A test that waits sixty seconds to see a window
 * expire is a test that gets deleted the first time it is slow.
 */

function clockFrom(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe('AbuseGuard', () => {
  it('allows up to the ceiling and refuses the next one', () => {
    const clock = clockFrom();
    const guard = new AbuseGuard({ maxRequests: 3, now: clock.now });

    expect(guard.check('1.2.3.4').allowed).toBe(true);
    expect(guard.check('1.2.3.4').allowed).toBe(true);
    expect(guard.check('1.2.3.4').allowed).toBe(true);

    const denied = guard.check('1.2.3.4');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts each address separately', () => {
    // One noisy client must not lock out everybody else.
    const clock = clockFrom();
    const guard = new AbuseGuard({ maxRequests: 1, now: clock.now });

    expect(guard.check('1.1.1.1').allowed).toBe(true);
    expect(guard.check('1.1.1.1').allowed).toBe(false);
    expect(guard.check('2.2.2.2').allowed).toBe(true);
    expect(guard.check('2.2.2.2').allowed).toBe(false);
  });

  it('lets a client back in once its window has passed', () => {
    const clock = clockFrom();
    const guard = new AbuseGuard({ maxRequests: 2, windowMs: 1000, now: clock.now });

    guard.check('9.9.9.9');
    guard.check('9.9.9.9');
    expect(guard.check('9.9.9.9').allowed).toBe(false);

    clock.advance(1001);
    expect(guard.check('9.9.9.9').allowed).toBe(true);
  });

  it('reports a retry-after that never rounds down to zero', () => {
    // A `retry-after: 0` tells a client to retry immediately, which is the one
    // thing it must not do.
    const clock = clockFrom();
    const guard = new AbuseGuard({ maxRequests: 1, windowMs: 1000, now: clock.now });
    guard.check('5.5.5.5');
    clock.advance(10);

    const verdict = guard.check('5.5.5.5');
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('forgets addresses with nothing left in the window', () => {
    const clock = clockFrom();
    const guard = new AbuseGuard({ maxRequests: 5, windowMs: 1000, now: clock.now });

    guard.check('a');
    guard.check('b');
    expect(guard.trackedAddresses).toBe(2);

    clock.advance(1001);
    guard.sweep();
    expect(guard.trackedAddresses).toBe(0);
  });

  it('keeps an address that still has hits in the window', () => {
    const clock = clockFrom();
    const guard = new AbuseGuard({ maxRequests: 5, windowMs: 1000, now: clock.now });

    guard.check('a');
    clock.advance(500);
    guard.check('a');
    clock.advance(600); // the first hit has aged out; the second has not

    guard.sweep();
    expect(guard.trackedAddresses).toBe(1);
  });

  it('clears everything on reset', () => {
    const guard = new AbuseGuard({ maxRequests: 1 });
    guard.check('x');
    guard.reset();
    expect(guard.trackedAddresses).toBe(0);
  });
});

describe('abuseGuard middleware', () => {
  function appWith(guard: AbuseGuard, logger: Logger = silentLogger()): Hono<AppEnv> {
    const app = new Hono<AppEnv>();
    app.use('*', requestContext());
    app.use('*', abuseGuard(guard, logger));
    app.get('/thing', (c) => c.json({ ok: true }));
    app.get('/healthz', (c) => c.json({ status: 'ok' }));
    app.get('/readyz', (c) => c.json({ status: 'ready' }));
    // The real handler, so the 429 here is the envelope a client actually gets.
    app.onError(errorLifecycle({ logger } as unknown as AppDeps));
    return app;
  }

  it('answers 429 with a retry-after once the ceiling is reached', async () => {
    const app = appWith(new AbuseGuard({ maxRequests: 2 }));

    expect((await app.request('/thing')).status).toBe(200);
    expect((await app.request('/thing')).status).toBe(200);

    const denied = await app.request('/thing');
    expect(denied.status).toBe(429);
    expect(denied.headers.get('retry-after')).not.toBeNull();
  });

  it('never counts the two probes', async () => {
    // A supervisor polling these must not be throttled into thinking the
    // instance is unhealthy — and a throttled `/readyz` would read as "not
    // ready", which is the opposite of true.
    const app = appWith(new AbuseGuard({ maxRequests: 1 }));

    for (let i = 0; i < 5; i += 1) {
      expect((await app.request('/healthz')).status).toBe(200);
      expect((await app.request('/readyz')).status).toBe(200);
    }
  });

  it('fails open when the counter itself breaks', async () => {
    // A broken counter is degraded protection, not a reason to refuse every
    // request the instance receives (R5.5).
    const broken = {
      check: () => {
        throw new Error('counter exploded');
      },
    } as unknown as AbuseGuard;

    const app = appWith(broken);
    expect((await app.request('/thing')).status).toBe(200);
  });
});
