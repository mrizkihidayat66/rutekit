import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import { CONSOLE_API_PREFIX } from '@contracts';

import { sessionGuard } from '@server/auth/guard.ts';
import { abuseGuard } from '@server/ingress/abuse.ts';
import { apiKeyGuard } from '@server/ingress/api-key-guard.ts';
import { bodyPolicy } from '@server/ingress/body-policy.ts';
import { errorLifecycle, notFoundHandler } from '@server/ingress/error-lifecycle.ts';
import { readinessGate } from '@server/ingress/readiness.ts';
import { requestContext } from '@server/ingress/request-context.ts';
import { accountRoutes } from '@server/routes/accounts.ts';
import { apiKeyRoutes } from '@server/routes/api-keys.ts';
import { authRoutes } from '@server/routes/auth.ts';
import { automationRoutes } from '@server/routes/automation.ts';
import { benchmarkRoutes } from '@server/routes/benchmark.ts';
import { chatRoutes } from '@server/routes/chat.ts';
import { consoleRoutes } from '@server/routes/console.ts';
import { healthRoutes } from '@server/routes/health.ts';
import { jobRoutes } from '@server/routes/jobs.ts';
import { metaRoutes } from '@server/routes/meta.ts';
import { overviewRoutes } from '@server/routes/overview.ts';
import { providerRoutes } from '@server/routes/providers.ts';
import { routingRoutes } from '@server/routes/routing.ts';
import { studioRoutes } from '@server/routes/studio.ts';
import { systemRoutes } from '@server/routes/system.ts';
import { tokenSaverRoutes } from '@server/routes/token-saver.ts';
import { toolsRoutes } from '@server/routes/tools.ts';
import { verificationRoutes } from '@server/routes/verification.ts';
import { v1Routes } from '@server/routes/v1.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The composition root.
 *
 * Everything a route can reach is assembled in `main.ts` and handed in here as
 * one object, so this file is a wiring diagram and nothing else: the order the
 * ingress stages run in, the two namespaces, and the socket. A route module
 * added in a later phase is one `route()` line and its own file — nothing here
 * has to learn what it does.
 *
 * Stage order is load-bearing:
 *   1. `requestContext` — nothing below it can log an id or count an address
 *      until it has run, so it runs first.
 *   2. `abuseGuard`     — on `*`, not on a namespace, so a flood of requests to
 *      paths that do not exist is counted too (CONTRIBUTING §5.2).
 *   3. `bodyPolicy`     — last of the three, because it is the only one that
 *      inspects the request body and it should be reached only by a request that
 *      has already been identified and counted.
 *   4. `readinessGate`  — scoped to the two namespaces, never to the probes.
 *   5. the two doors    — the session guard on the control plane and the API-key
 *      guard on the data plane, each after readiness: a draining server answers
 *      503 whether or not the caller could have authenticated.
 *
 * The two namespaces carry the two audiences (ADR-0003) and therefore the two
 * authentications. `/console/api` is opened by a cookie the session guard reads;
 * `/v1` is opened by a bearer key the API-key guard reads. Neither guard can see
 * the other's routes, so a key can never edit the pool and the dashboard can
 * never spend a key's budget.
 *
 *   6. the console's own files — registered **last**, because it is a catch-all
 *      and everything above has to have had its chance first. Where they are is a
 *      dependency (`deps.console`) rather than something computed here, so a test
 *      decides whether a console exists at all. See `console.ts`.
 */
export function buildApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', requestContext());
  app.use('*', abuseGuard(deps.abuse, deps.logger));
  app.use('*', bodyPolicy());

  app.use(`${CONSOLE_API_PREFIX}/*`, readinessGate(deps.lifecycle));
  app.use('/v1/*', readinessGate(deps.lifecycle));

  app.use(`${CONSOLE_API_PREFIX}/*`, sessionGuard(deps.auth));
  app.use('/v1/*', apiKeyGuard(deps.apiKeys, deps.keyLimiter));

  app.onError(errorLifecycle(deps));
  app.notFound(notFoundHandler());

  app.route('/', healthRoutes(deps));
  app.route(CONSOLE_API_PREFIX, metaRoutes(deps));
  app.route(CONSOLE_API_PREFIX, authRoutes(deps));
  app.route(CONSOLE_API_PREFIX, apiKeyRoutes(deps));
  app.route(CONSOLE_API_PREFIX, providerRoutes(deps));
  app.route(CONSOLE_API_PREFIX, accountRoutes(deps));
  app.route(CONSOLE_API_PREFIX, routingRoutes(deps));
  app.route(CONSOLE_API_PREFIX, tokenSaverRoutes(deps));
  app.route(CONSOLE_API_PREFIX, overviewRoutes(deps));
  app.route(CONSOLE_API_PREFIX, automationRoutes(deps));
  app.route(CONSOLE_API_PREFIX, jobRoutes(deps));
  app.route(CONSOLE_API_PREFIX, toolsRoutes(deps));
  app.route(CONSOLE_API_PREFIX, chatRoutes(deps));
  app.route(CONSOLE_API_PREFIX, studioRoutes(deps));
  app.route(CONSOLE_API_PREFIX, benchmarkRoutes(deps));
  app.route(CONSOLE_API_PREFIX, verificationRoutes(deps));
  app.route(CONSOLE_API_PREFIX, systemRoutes(deps));

  app.route('/v1', v1Routes(deps));

  // **Before the console's catch-all, and this ordering is the whole route.**
  // `consoleRoutes` registers `app.get('*')`, and Hono matches in registration
  // order — so a `/ws` declared after it is never reached. It is not merely
  // shadowed either: `/ws` is on the console's reserved list, so the catch-all
  // answers it with a 404 rather than with `index.html`, and the failure reads as
  // a route that was never registered.
  //
  // That is exactly what happened. The socket worked in development, where Vite
  // serves the console and `consoleRoutes` returns early because there is no
  // build, and was a 404 in the binary and the container — the two places a
  // browser-driven feature is actually used.
  app.get('/ws', wsRoute(deps));

  // Last, so every route above wins first. A no-op when there is no build —
  // which is the case in development, where Vite serves the console.
  consoleRoutes(app, deps.console);

  return app;
}

/**
 * One socket per client, multiplexed by channel (ADR-0012). The connection id
 * is minted before the upgrade is answered so the `hello` the hub sends on open
 * already carries it, and the same id keys every later frame from this peer.
 */
function wsRoute(deps: AppDeps) {
  return upgradeWebSocket(() => {
    const connectionId = crypto.randomUUID();
    return {
      onOpen(_event, ws) {
        deps.hub.open(ws, connectionId);
      },
      onMessage(event, _ws) {
        const data = event.data;
        if (typeof data === 'string' || data instanceof ArrayBuffer) {
          deps.hub.handleRaw(connectionId, data);
        }
      },
      onClose() {
        deps.hub.close(connectionId);
      },
      onError(error) {
        deps.logger.warn({ err: error, connectionId }, 'ws error');
      },
    };
  });
}
