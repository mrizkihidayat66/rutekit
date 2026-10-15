import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONSOLE_API_PREFIX, authStatusSchema, consoleErrorSchema, consolePaths } from '@contracts';

import { buildApp } from '@server/app.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The auth surface, end to end (D8, C2.3).
 *
 * Through `buildApp` and the real routes, because the thing worth testing is the
 * whole conversation — a cookie set by setup, read back by the guard, and turned
 * into a 401 the moment it stops being live. The database is real; only the clock
 * is a person's.
 */

const PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'a-different-long-passphrase';

function url(path: string): string {
  return `${CONSOLE_API_PREFIX}${path}`;
}

const STATUS = url(consolePaths.authStatus);
const SETUP = url(consolePaths.authSetup);
const LOGIN = url(consolePaths.authLogin);
const LOGOUT = url(consolePaths.authLogout);
const PASSWORD_PATH = url(consolePaths.authPassword);
/** A console route behind the guard, used to prove the cookie actually opens it. */
const PROTECTED = url(consolePaths.apiKeys);

type App = ReturnType<typeof buildApp>;

async function postJson(app: App, path: string, body: unknown, cookie?: string): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

/** The refusal, read through the contract's envelope rather than off `unknown`. */
async function errorOf(response: Response): Promise<{ kind: string; message: string }> {
  return consoleErrorSchema.parse(await response.json()).error;
}

/** The `name=value` pair from a `set-cookie` header, ready to send back. */
function cookieOf(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) throw new Error('expected a session cookie');
  const pair = setCookie.split(';')[0];
  if (pair === undefined) throw new Error('empty set-cookie header');
  return pair;
}

async function setUp(app: App): Promise<string> {
  const response = await postJson(app, SETUP, { password: PASSWORD, instanceName: 'Test' });
  expect(response.status).toBe(200);
  return cookieOf(response);
}

let server: TestServer;

beforeEach(() => {
  server = makeServer();
  server.lifecycle.markReady();
});

afterEach(() => {
  server.close();
});

describe('auth status', () => {
  it('is reachable without a session and reports an unconfigured instance', async () => {
    const app = buildApp(server);

    const response = await app.request(STATUS);
    expect(response.status).toBe(200);

    const status = authStatusSchema.parse(await response.json());
    expect(status).toEqual({ configured: false, authenticated: false, sessionExpiresAt: null });
  });

  it('never carries the password or a hash', async () => {
    const app = buildApp(server);
    const cookie = await setUp(app);

    const raw = await (await app.request(STATUS, { headers: { cookie } })).text();
    expect(raw).not.toContain(PASSWORD);
    expect(raw).not.toContain('$argon2');
  });
});

describe('setup', () => {
  it('creates the password, opens a session and reports both', async () => {
    const app = buildApp(server);

    const response = await postJson(app, SETUP, { password: PASSWORD, instanceName: 'Home' });
    expect(response.status).toBe(200);

    const status = authStatusSchema.parse(await response.json());
    expect(status.configured).toBe(true);
    expect(status.authenticated).toBe(true);
    expect(status.sessionExpiresAt).not.toBeNull();

    const cookie = cookieOf(response);
    const read = await app.request(STATUS, { headers: { cookie } });
    expect(authStatusSchema.parse(await read.json()).authenticated).toBe(true);
  });

  it('marks the cookie HttpOnly and SameSite=Lax', async () => {
    const app = buildApp(server);
    const response = await postJson(app, SETUP, { password: PASSWORD, instanceName: 'Home' });

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
  });

  it('refuses a second setup', async () => {
    const app = buildApp(server);
    await setUp(app);

    const again = await postJson(app, SETUP, { password: PASSWORD, instanceName: 'Again' });
    expect(again.status).toBe(403);
  });

  it('refuses a password shorter than the contract allows', async () => {
    const app = buildApp(server);

    const response = await postJson(app, SETUP, { password: 'short', instanceName: 'Home' });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).kind).toBe('invalid_request');
  });
});

describe('login', () => {
  it('opens a session for the right password and refuses the wrong one', async () => {
    const app = buildApp(server);
    await setUp(app);

    const wrong = await postJson(app, LOGIN, { password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expect((await errorOf(wrong)).kind).toBe('authentication');

    const right = await postJson(app, LOGIN, { password: PASSWORD });
    expect(right.status).toBe(200);
    expect(authStatusSchema.parse(await right.json()).authenticated).toBe(true);
  });

  it('refuses a login before the instance has been set up', async () => {
    const app = buildApp(server);

    const response = await postJson(app, LOGIN, { password: PASSWORD });
    expect(response.status).toBe(403);
  });
});

describe('logout', () => {
  it('ends the session the cookie names', async () => {
    const app = buildApp(server);
    const cookie = await setUp(app);

    expect((await app.request(STATUS, { headers: { cookie } })).status).toBe(200);

    const out = await postJson(app, LOGOUT, {}, cookie);
    expect(out.status).toBe(200);

    const after = await app.request(STATUS, { headers: { cookie } });
    expect(authStatusSchema.parse(await after.json()).authenticated).toBe(false);
  });

  it('succeeds even when there was no session, so the cookie is still cleared', async () => {
    const app = buildApp(server);
    await setUp(app);

    const out = await postJson(app, LOGOUT, {});
    expect(out.status).toBe(200);
    expect((out.headers.get('set-cookie') ?? '').toLowerCase()).toContain('max-age=0');
  });
});

describe('the session guard', () => {
  it('refuses a protected console route without a session', async () => {
    const app = buildApp(server);

    const response = await app.request(PROTECTED);
    expect(response.status).toBe(401);
    expect((await errorOf(response)).kind).toBe('authentication');
  });

  it('lets the session through to the route behind it', async () => {
    const app = buildApp(server);
    const cookie = await setUp(app);

    const response = await app.request(PROTECTED, { headers: { cookie } });
    expect(response.status).toBe(200);
  });

  it('refuses a cookie that was never issued', async () => {
    const app = buildApp(server);
    await setUp(app);

    const response = await app.request(PROTECTED, {
      headers: { cookie: 'rutekit_session=made-up-token' },
    });
    expect(response.status).toBe(401);
  });
});

describe('changing the password', () => {
  it('needs a session and the current password', async () => {
    const app = buildApp(server);
    await setUp(app);

    const noSession = await postJson(app, PASSWORD_PATH, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(noSession.status).toBe(401);

    const cookie = cookieOf(await postJson(app, LOGIN, { password: PASSWORD }));
    const wrongCurrent = await postJson(
      app,
      PASSWORD_PATH,
      { currentPassword: 'wrong', newPassword: NEW_PASSWORD },
      cookie,
    );
    expect(wrongCurrent.status).toBe(401);
  });

  it('replaces the password and ends every other session', async () => {
    const app = buildApp(server);
    const first = await setUp(app);
    const second = cookieOf(await postJson(app, LOGIN, { password: PASSWORD }));

    const changed = await postJson(
      app,
      PASSWORD_PATH,
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      first,
    );
    expect(changed.status).toBe(200);

    // The session that asked survives; the one opened elsewhere does not.
    expect((await app.request(PROTECTED, { headers: { cookie: first } })).status).toBe(200);
    expect((await app.request(PROTECTED, { headers: { cookie: second } })).status).toBe(401);

    // And the new password is the one that works.
    expect((await postJson(app, LOGIN, { password: PASSWORD })).status).toBe(401);
    expect((await postJson(app, LOGIN, { password: NEW_PASSWORD })).status).toBe(200);
  });
});
