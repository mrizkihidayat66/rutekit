import type { MiddlewareHandler } from 'hono';

import { AppError } from '@server/errors.ts';
import type { Lifecycle } from '@server/runtime/lifecycle.ts';
import type { AppEnv } from '@server/types.ts';

/**
 * Refusing work the instance cannot finish.
 *
 * Mounted on `/console/api` and `/v1` but deliberately *not* on `/healthz` or
 * `/readyz`: those two exist to report this state, so gating them behind it
 * would make the instance unable to say why it is refusing traffic (A23).
 *
 * A request already in flight when the drain begins is left to finish; only a
 * request that arrives after the drain starts is refused, and with a
 * `retry-after` so a client knows to come back rather than give up.
 */
export function readinessGate(lifecycle: Lifecycle): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!lifecycle.acceptingRequests) {
      c.header('retry-after', '1');
      throw AppError.shuttingDown();
    }
    await next();
  };
}
