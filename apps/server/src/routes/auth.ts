import { Hono } from 'hono';
import type { Ok } from '@contracts';
import { consolePaths, loginBodySchema, passwordChangeBodySchema, setupBodySchema } from '@contracts';

import { clearSessionCookie, readSessionCookie, writeSessionCookie } from '@server/auth/cookie.ts';
import { jsonBody } from '@server/ingress/validate.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The five auth routes (D8).
 *
 * Thin by design (RULESET R5.2): each one reads a cookie, calls the service, and
 * writes a cookie back. The decisions — what makes a password acceptable, when a
 * session expires, which sessions a password change ends — live in
 * `auth/service.ts`, so this file reads as the shape of the conversation rather
 * than its rules.
 *
 * `status` is the one route the gate polls before it knows anything, which is
 * why it answers 200 in all three states rather than 401 when nobody is signed
 * in: "not signed in" is the answer, not an error.
 */
export function authRoutes(deps: AppDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { auth } = deps;

  router.get(consolePaths.authStatus, (c) => c.json(auth.status(readSessionCookie(c))));

  router.post(consolePaths.authSetup, jsonBody(setupBodySchema), async (c) => {
    const issued = await auth.setup(c.req.valid('json'));
    writeSessionCookie(c, issued.token, new Date(issued.expiresAt));
    return c.json(issued.status);
  });

  router.post(consolePaths.authLogin, jsonBody(loginBodySchema), async (c) => {
    const issued = await auth.login(c.req.valid('json').password);
    writeSessionCookie(c, issued.token, new Date(issued.expiresAt));
    return c.json(issued.status);
  });

  // Reachable without a session on purpose: a logout that failed because the
  // session behind it had already expired would leave the cookie in place.
  router.post(consolePaths.authLogout, (c) => {
    auth.logout(readSessionCookie(c));
    clearSessionCookie(c);
    return c.json({ ok: true } satisfies Ok);
  });

  router.post(consolePaths.authPassword, jsonBody(passwordChangeBodySchema), async (c) => {
    await auth.changePassword(c.req.valid('json'), c.get('sessionId'));
    return c.json({ ok: true } satisfies Ok);
  });

  return router;
}
