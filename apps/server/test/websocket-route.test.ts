import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { websocket } from 'hono/bun';
import { wsServerMessageSchema } from '@contracts';

import { buildApp } from '@server/app.ts';
import { diskConsole, NO_CONSOLE } from '@server/routes/console.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The `/ws` route, over a real socket (ADR-0012).
 *
 * **This file exists because the route was a 404 and nothing noticed.** The hub
 * has its own suite, the console's serving has its own suite, and the socket
 * between them was never once opened by a test — so the route could be shadowed
 * and stay shadowed. It was: `/ws` was registered after the console's catch-all,
 * `/ws` is on the console's reserved list, and the catch-all answered it with a
 * 404. Development hid it, because Vite serves the console there and the
 * catch-all is never registered — so the only two places a browser-driven
 * feature is used, the binary and the container, were the two where it did not
 * work.
 *
 * **A plain `GET /ws` cannot detect that, which is the trap worth naming.** Before
 * the fix and after it, that request answers the same JSON 404 — the console
 * refuses the path, and the server's own not-found handler does too. Only an
 * actual upgrade tells the two apart, so this stands a real listener up and
 * completes a real handshake.
 */

const servers: TestServer[] = [];
const listeners: { stop: () => void }[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
  for (const listener of listeners) listener.stop();
  listeners.length = 0;
});

/** A checkout with a build in it, so the console's catch-all is registered. */
function fakeBuild(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), 'rutekit-ws-'));
  const dist = join(repoRoot, 'apps', 'web', 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>rutekit</title>', 'utf8');
  return dist;
}

/** The app, listening for real, with a console build present. */
function listening(withConsole: boolean): string {
  const server = makeServer({
    console: withConsole ? (diskConsole(fakeBuild()) ?? NO_CONSOLE) : NO_CONSOLE,
  });
  server.lifecycle.markReady();
  servers.push(server);

  const app = buildApp(server);
  const listener = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch, websocket });
  listeners.push(listener);
  return `ws://127.0.0.1:${String(listener.port)}/ws`;
}

/** Open a socket and collect frames until one matches, or the clock runs out. */
function collect(url: string, ms = 5_000): Promise<{ types: string[]; frames: unknown[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const types: string[] = [];
    const frames: unknown[] = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`no frames within ${String(ms)}ms; saw ${JSON.stringify(types)}`));
    }, ms);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'subscribe', channels: ['preview'] }));
    });
    socket.addEventListener('message', (event) => {
      const parsed = wsServerMessageSchema.safeParse(JSON.parse(String(event.data)));
      if (!parsed.success) {
        clearTimeout(timer);
        socket.close();
        reject(new Error('a frame did not match the contract'));
        return;
      }
      types.push(parsed.data.type);
      frames.push(parsed.data);
      // `hello` first, then `hello` again carrying the accepted channels.
      if (types.filter((type) => type === 'hello').length >= 2) {
        clearTimeout(timer);
        socket.close();
        resolve({ types, frames });
      }
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`the socket to ${url} could not be opened`));
    });
  });
}

describe('the websocket route', () => {
  it('upgrades, and answers a subscribe with the channels it accepted', async () => {
    const url = listening(true);
    const { frames } = await collect(url);

    // The second `hello` is the one the hub sends in reply to a subscribe, and it
    // is the proof that the frame reached the hub rather than a catch-all.
    const hello = frames.at(-1) as { channels: string[]; heartbeatSeconds: number };
    expect(hello.channels).toEqual(['preview']);
    expect(hello.heartbeatSeconds).toBeGreaterThan(0);
  }, 20_000);

  it('is reachable with a console build present, which is where it was not', async () => {
    // The regression this pins: with a build, the catch-all is registered, and a
    // `/ws` route declared after it never runs. The socket above is the assertion;
    // this one names the condition under which it used to fail.
    const withConsole = await collect(listening(true));
    expect(withConsole.types[0]).toBe('hello');
  }, 20_000);

  it('is reachable with no console build, which is how development runs', async () => {
    const withoutConsole = await collect(listening(false));
    expect(withoutConsole.types[0]).toBe('hello');
  }, 20_000);
});
