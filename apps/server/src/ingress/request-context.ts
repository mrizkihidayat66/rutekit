import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '@server/types.ts';
import { deriveClientIp, peerAddress } from './client-ip.ts';

/**
 * The first stage of the ingress pipeline: identity.
 *
 * Every request gets an id before anything can fail, so the id can be put in the
 * error envelope the client receives and in every log line the request
 * produces. That is the whole point — "it failed" becomes "it failed, here is
 * the one string that finds it". The client address is derived here too, by the
 * one rule that decides whether `X-Forwarded-For` may be believed (A24).
 */
export function requestContext(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('requestId', crypto.randomUUID());
    c.set('startedAtMs', Date.now());
    c.set('clientIp', deriveClientIp(peerAddress(c), c.req.header('x-forwarded-for') ?? null));
    await next();
  };
}
