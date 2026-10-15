import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { CONSOLE_API_PREFIX, consolePaths } from '@contracts';

import { buildApp } from '@server/app.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * Test isolation (ROADMAP D1: "test DB terisolasi").
 *
 * Every server test builds its own instance through `makeServer`, and each one is
 * meant to get a database and a data directory of its own. That property is what
 * makes the suite order-independent — a test that seeds an account cannot change
 * what the next test sees — and it is currently true *by construction* rather
 * than by assertion: `:memory:` happens to be per-call, and `mkdtempSync` happens
 * to be unique.
 *
 * "Happens to be" is the part worth pinning down. A change to `makeServer` that
 * pointed every test at one file-backed database would keep the suite green in
 * isolation and turn it into an order-dependent flake under `--shuffle`, and the
 * failure would surface as an unrelated test failing intermittently — one of the
 * most expensive kinds of bug to chase. So the guarantee is asserted here, once,
 * where a change that breaks it fails immediately and names itself.
 *
 * These drive the real app rather than poking at the harness: a write through the
 * console is what a test actually does, so that is what has to be isolated.
 */

const PASSWORD = 'correct-horse-battery';

const servers: TestServer[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
});

function build(): { server: TestServer; app: ReturnType<typeof buildApp> } {
  const server = makeServer();
  server.lifecycle.markReady();
  servers.push(server);
  return { server, app: buildApp(server) };
}

async function signIn(app: ReturnType<typeof buildApp>): Promise<string> {
  const response = await app.request(`${CONSOLE_API_PREFIX}${consolePaths.authSetup}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, instanceName: 'Test' }),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) throw new Error('setup did not set a session cookie');
  const pair = setCookie.split(';')[0];
  if (pair === undefined) throw new Error('empty set-cookie header');
  return pair;
}

/** Rename the instance, which is one row in one table, and read it back. */
async function rename(
  app: ReturnType<typeof buildApp>,
  cookie: string,
  name: string,
): Promise<string> {
  const response = await app.request(`${CONSOLE_API_PREFIX}${consolePaths.generalSettings}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ instanceName: name }),
  });
  const body = (await response.json()) as { instanceName: string };
  return body.instanceName;
}

describe('test isolation', () => {
  it('gives each server its own database', async () => {
    const first = build();
    const second = build();

    await rename(first.app, await signIn(first.app), 'first');

    // The second instance has never been named, so it reports the default — the
    // first server's write is invisible here, which is the whole property.
    const listed = await second.app.request(
      `${CONSOLE_API_PREFIX}${consolePaths.generalSettings}`,
      { headers: { cookie: await signIn(second.app) } },
    );
    const body = (await listed.json()) as { instanceName: string };

    expect(body.instanceName).not.toBe('first');
  });

  it('gives each server its own data directory', () => {
    const first = build();
    const second = build();

    expect(first.server.dataDir).not.toBe(second.server.dataDir);
    expect(existsSync(first.server.dataDir)).toBe(true);
    expect(existsSync(second.server.dataDir)).toBe(true);
  });

  it('closes one server without disturbing another', async () => {
    const first = build();
    const second = build();
    const cookie = await signIn(second.app);
    await rename(second.app, cookie, 'second');

    first.server.close();
    servers.splice(servers.indexOf(first.server), 1);

    // The survivor still answers, and still holds what it was told — a shared
    // handle would have taken it down with the other one.
    const listed = await second.app.request(
      `${CONSOLE_API_PREFIX}${consolePaths.generalSettings}`,
      { headers: { cookie } },
    );
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { instanceName: string }).instanceName).toBe('second');
  });

  it('starts every server from the same empty state', async () => {
    // Two instances built one after the other, neither touched, must report the
    // same thing — the assertion that catches state leaking in through a
    // module-level singleton or a fixture built once at import time.
    const read = async (): Promise<string> => {
      const { app } = build();
      const response = await app.request(`${CONSOLE_API_PREFIX}${consolePaths.generalSettings}`, {
        headers: { cookie: await signIn(app) },
      });
      return JSON.stringify(await response.json());
    };

    expect(await read()).toBe(await read());
  });
});
