import { Hono } from 'hono';

import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The two probes, and why there are two (A23).
 *
 * `/healthz` answers "is this process alive?" and stays 200 for as long as it is
 * running — including while it drains, because a supervisor that restarts a
 * process mid-drain kills the requests it was politely finishing.
 *
 * `/readyz` answers "should this process take new work?" and turns 503 the
 * moment draining starts or the database stops answering, so a load balancer
 * stops routing to it without the process being restarted.
 *
 * Both sit outside `/console/api` and `/v1`: they are for the supervisor, not
 * for the dashboard, and they are the two routes the readiness gate must never
 * refuse.
 */
export function healthRoutes(deps: AppDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/healthz', (c) =>
    c.json({
      status: 'ok',
      state: deps.lifecycle.state,
      uptimeSeconds: deps.lifecycle.uptimeSeconds,
      connections: deps.hub.connectionCount,
    }),
  );

  router.get('/readyz', (c) => {
    const databaseUp = deps.persistence.ping();
    const ready = deps.lifecycle.acceptingRequests && databaseUp;
    const body = {
      status: ready ? 'ready' : 'not_ready',
      state: deps.lifecycle.state,
      checks: { database: databaseUp ? 'up' : 'down' },
      uptimeSeconds: deps.lifecycle.uptimeSeconds,
    };
    if (!ready) c.header('retry-after', '1');
    return c.json(body, ready ? 200 : 503);
  });

  return router;
}
