import type { MiddlewareHandler } from 'hono';
import { CONSOLE_API_PREFIX, consolePaths } from '@contracts';

import { AppError } from '@server/errors.ts';
import type { AppEnv } from '@server/types.ts';
import { readSessionCookie } from './cookie.ts';
import type { AuthService } from './service.ts';

/**
 * The console's door.
 *
 * Applied to the whole control plane, with an explicit list of the paths that
 * stay open. An allowlist rather than a denylist of protected routes: a route
 * added in a later phase is closed until someone decides otherwise, and the
 * failure mode of forgetting is a 401 in development rather than an open
 * endpoint in production.
 *
 * The four open paths are the ones that have to be reachable *before* there is a
 * session — the status the gate reads, the wizard that creates the first one,
 * the login that creates the next, and the logout that has to work even after
 * the session behind it has already gone.
 */

const OPEN_PATHS: readonly string[] = [
  consolePaths.authStatus,
  consolePaths.authSetup,
  consolePaths.authLogin,
  consolePaths.authLogout,
].map((path) => `${CONSOLE_API_PREFIX}${path}`);

export function sessionGuard(auth: AuthService): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (OPEN_PATHS.includes(c.req.path)) {
      await next();
      return;
    }

    const session = auth.resolve(readSessionCookie(c));
    if (session === null) throw AppError.authentication();

    c.set('sessionId', session.id);
    c.set('sessionExpiresAt', session.expiresAt);
    await next();
  };
}
