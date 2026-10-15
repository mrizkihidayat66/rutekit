import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import type { AppEnv } from '@server/types.ts';

/**
 * The session cookie.
 *
 * HttpOnly so a script on the page cannot read it, and SameSite=Lax so a
 * cross-site request cannot carry it — that is the whole of the console's CSRF
 * story, because every mutating route here is a POST, PATCH or DELETE, and Lax
 * withholds the cookie from all three when the request did not start on this
 * origin.
 *
 * `Secure` is set only when the request arrived over TLS. The server itself
 * speaks plain HTTP behind whatever proxy the operator put in front of it, and a
 * `Secure` cookie handed back over http is one the browser silently drops — so
 * the header the proxy sets is the only honest signal available here.
 */

const COOKIE_NAME = 'rutekit_session';

function isSecure(c: Context<AppEnv>): boolean {
  const forwarded = c.req.header('x-forwarded-proto');
  return forwarded?.split(',')[0]?.trim() === 'https';
}

export function readSessionCookie(c: Context<AppEnv>): string | null {
  return getCookie(c, COOKIE_NAME) ?? null;
}

export function writeSessionCookie(c: Context<AppEnv>, token: string, expiresAt: Date): void {
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: isSecure(c),
    expires: expiresAt,
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  deleteCookie(c, COOKIE_NAME, { path: '/', secure: isSecure(c) });
}
