import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONSOLE_API_PREFIX, consoleErrorSchema, consolePaths } from '@contracts';

import { buildApp } from '@server/app.ts';
import {
  NO_CONSOLE,
  diskConsole,
  embeddedConsole,
  fileWithin,
  locateConsole,
} from '@server/routes/console.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * Serving the built console from the server (D3).
 *
 * Until D3 nothing did, and the gap was invisible because every test and every
 * manual check ran behind Vite — which serves the console and proxies the API, so
 * the server never had to. A binary or a container has no Vite, so each of them
 * started a server whose root path answered 404.
 *
 * The assertions here are about the two ways that can go wrong once a catch-all
 * exists. The first is **stealing a path the server owns**: a catch-all registered
 * last still matches anything no route claimed, so `/console/api/nope` would be
 * answered with `index.html` — a 200 carrying HTML where the console's own client
 * expects a JSON error envelope, and a failure it reports as "response did not
 * match its contract". The second is **serving a file it should not**: a URL is
 * attacker-controlled, so `../` has to be inert.
 *
 * A real `dist` is built in a temp directory rather than in the repository: the
 * repository's own `apps/web/dist` exists or not depending on whether anyone has
 * run `bun run build`, and a test whose behaviour depends on that would pass on
 * one machine and fail on another.
 */

const PASSWORD = 'correct-horse-battery';

const servers: TestServer[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
});

/**
 * A stand-in repository with a build in it.
 *
 * The layout matters: `locateConsole` looks for `apps/web/dist` under the repo
 * root, so the temp directory is a fake *checkout* and the build sits where a real
 * one would. Returns the checkout root, not the build directory.
 */
function fakeCheckout(): { readonly repoRoot: string; readonly dist: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'rutekit-console-'));
  const dist = join(repoRoot, 'apps', 'web', 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>rutekit</title>', 'utf8');
  writeFileSync(join(dist, 'assets', 'index-a1b2c3.js'), 'console.log("app")', 'utf8');
  writeFileSync(join(dist, 'assets', 'app-d4e5f6.css'), 'body{}', 'utf8');
  writeFileSync(join(dist, 'favicon.svg'), '<svg/>', 'utf8');
  // A canary *outside* the build. Without it the traversal test below would pass
  // whether the containment check worked or the file simply did not exist — which
  // is exactly how it passed the first time it was written.
  writeFileSync(join(repoRoot, 'CANARY.txt'), 'this file is outside the build', 'utf8');
  return { repoRoot, dist };
}

/** Just the build directory, for the harness. */
function fakeBuild(): string {
  return fakeCheckout().dist;
}

async function harness(
  root: string | null,
): Promise<{ app: ReturnType<typeof buildApp>; cookie: string }> {
  const server = makeServer({
    console: root === null ? NO_CONSOLE : (diskConsole(root) ?? NO_CONSOLE),
  });
  server.lifecycle.markReady();
  servers.push(server);

  const app = buildApp(server);
  const response = await app.request(`${CONSOLE_API_PREFIX}${consolePaths.authSetup}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, instanceName: 'Test' }),
  });
  const setCookie = response.headers.get('set-cookie');
  const cookie = setCookie === null ? '' : (setCookie.split(';')[0] ?? '');
  return { app, cookie };
}

function get(app: ReturnType<typeof buildApp>, path: string): Promise<Response> {
  return Promise.resolve(app.request(path));
}

describe('with no build', () => {
  it('leaves the root path alone, which is what development relies on', async () => {
    // `bun run dev` has no `dist` and does not want one: Vite is serving the
    // console on its own port and proxying the API here. A server that refused to
    // boot without a build artefact would break that for everyone.
    const { app } = await harness(null);

    const response = await get(app, '/');

    expect(response.status).toBe(404);
  });

  it('still answers the API', async () => {
    const { app, cookie } = await harness(null);

    const response = await app.request(`${CONSOLE_API_PREFIX}${consolePaths.authStatus}`, {
      headers: { cookie },
    });

    expect(response.status).toBe(200);
  });
});

describe('with a build', () => {
  it('serves the entry document at the root', async () => {
    const { app } = await harness(fakeBuild());

    const response = await get(app, '/');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<!doctype html>');
  });

  it('answers a client-side route with the entry document', async () => {
    // `/cli-tools` and every other page route exist only in the browser's router.
    // A reload on one is a request the server has never heard of, and answering
    // 404 there would make every deep link unusable.
    const { app } = await harness(fakeBuild());

    const response = await get(app, '/cli-tools');

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<!doctype html>');
    // The entry document must never be cached as immutable, or a deploy would
    // never be picked up — it is the one file whose name does not change.
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves a hashed asset as immutable', async () => {
    const { app } = await harness(fakeBuild());

    const response = await get(app, '/assets/index-a1b2c3.js');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    // Not an optimisation: the abuse guard counts every request per address with
    // a 600-a-minute ceiling, and a page load is around fifty requests. Caching
    // is what keeps a reload from competing with the protection.
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(await response.text()).toContain('console.log');
  });

  it('types the assets it serves', async () => {
    const { app } = await harness(fakeBuild());

    expect((await get(app, '/assets/app-d4e5f6.css')).headers.get('content-type')).toContain(
      'text/css',
    );
    expect((await get(app, '/favicon.svg')).headers.get('content-type')).toBe('image/svg+xml');
  });

  it('leaves every path the server owns to the server', async () => {
    // The failure this prevents: the catch-all answering `/console/api/nope` with
    // HTML and a 200, which the console's client reports as a contract mismatch
    // rather than as the 404 it is.
    const { app, cookie } = await harness(fakeBuild());

    // The probes are real routes and answer 200 by design — what matters is that
    // the *server* answered them, in JSON, rather than the catch-all handing back
    // an HTML document.
    for (const path of ['/healthz', '/readyz']) {
      const response = await get(app, path);
      expect(response.status, `${path} was not served by the server`).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
    }

    // The two namespaces are where it would actually bite. An unknown API path has
    // to be the server's own JSON, never a 200 carrying `index.html`. What status
    // it is depends on the guard: `/console/api/nope` is a 404, and `/v1/nope` is a
    // 401 because the key guard runs on the namespace before routing — you cannot
    // learn whether a path exists without a key. Both are the server answering.
    for (const path of [`${CONSOLE_API_PREFIX}/nope`, '/v1/nope']) {
      const response = await app.request(path, { headers: { cookie } });
      expect(response.status, `${path} was answered by the console`).not.toBe(200);
      expect(response.headers.get('content-type'), `${path} answered HTML`).toContain(
        'application/json',
      );
    }

    const unknown = await app.request(`${CONSOLE_API_PREFIX}/nope`, { headers: { cookie } });
    expect(unknown.status).toBe(404);
    expect(consoleErrorSchema.safeParse(await unknown.json()).success).toBe(true);
  });

  it('never serves a file outside the build, however the path is spelled', async () => {
    const checkout = fakeCheckout();
    const { app } = await harness(checkout.dist);

    // `CANARY.txt` sits beside the build and exists, so a check that did nothing
    // would serve it. This asserts the *outcome* rather than the mechanism: no
    // spelling of "go up one" gets a file out of the build.
    //
    // Worth knowing what is doing the work: `new URL(...).pathname` has already
    // collapsed `..` before the route sees it, so these arrive normalised. The
    // containment check inside `fileWithin` is a second line that a real request
    // cannot reach — which is why it is pinned directly in the block below rather
    // than only through this one.
    for (const path of [
      '/../CANARY.txt',
      '/assets/../../CANARY.txt',
      '/%2e%2e/CANARY.txt',
      '/assets/%2e%2e/%2e%2e/CANARY.txt',
      '/..\\CANARY.txt',
    ]) {
      const response = await get(app, path);
      const body = await response.text();
      expect(body, `${path} served a file outside the build`).not.toContain('this file is outside');
      expect(body, `${path} did not fall back to the app`).toContain('<!doctype html>');
    }
  });

  it('answers a malformed escape rather than falling over', async () => {
    // `decodeURIComponent('%')` throws, and an unhandled throw in the catch-all
    // would be a 500 for a request that only got its encoding wrong.
    const { app } = await harness(fakeBuild());

    const response = await get(app, '/%');

    expect(response.status).toBe(404);
  });

  it('serves a 404-shaped path as the app rather than as an error', async () => {
    // A deep link into a route the router does not know is still the app's
    // business: it renders its own NotFound page. The server cannot tell that
    // apart from a real route, and should not try.
    const { app } = await harness(fakeBuild());

    const response = await get(app, '/definitely-not-a-route');

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<!doctype html>');
  });
});

/**
 * The containment check, at its own boundary.
 *
 * Not reachable through a request — `new URL(...).pathname` normalises `..` away
 * first — so driving it through one would assert the URL parser's behaviour and
 * say nothing about this function. Called directly, with a real file outside the
 * build, the check is what stands between a path and that file.
 */
describe('fileWithin', () => {
  it('refuses a path that resolves outside the root', () => {
    const { repoRoot, dist } = fakeCheckout();
    const canary = join(repoRoot, 'CANARY.txt');

    expect(existsSync(canary)).toBe(true);
    expect(fileWithin(dist, '../CANARY.txt')).toBeNull();
    expect(fileWithin(dist, 'assets/../../CANARY.txt')).toBeNull();
    // The Windows separator too: a path is a path whatever it was spelled with.
    expect(fileWithin(dist, '..\\CANARY.txt')).toBeNull();
  });

  it('refuses a sibling directory that shares a name prefix', () => {
    // `dist-other` starts with `dist`, so a naive `startsWith` would let it
    // through. Appending the separator is what makes the comparison a containment
    // test rather than a string prefix test.
    const { dist } = fakeCheckout();
    const sibling = `${dist}-other`;
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, 'inside.txt'), 'a sibling of the build', 'utf8');

    expect(fileWithin(dist, '../dist-other/inside.txt')).toBeNull();
  });

  it('serves a real file inside the root', () => {
    const { dist } = fakeCheckout();

    expect(fileWithin(dist, 'assets/index-a1b2c3.js')).toBe(
      join(dist, 'assets', 'index-a1b2c3.js'),
    );
    // A leading separator is stripped rather than joined, which on Windows would
    // otherwise produce a UNC-shaped path.
    expect(fileWithin(dist, '/assets/index-a1b2c3.js')).toBe(
      join(dist, 'assets', 'index-a1b2c3.js'),
    );
  });

  it('answers null for a path that is only separators, and for one that is not there', () => {
    const { dist } = fakeCheckout();

    expect(fileWithin(dist, '/')).toBeNull();
    expect(fileWithin(dist, '')).toBeNull();
    expect(fileWithin(dist, 'nope.txt')).toBeNull();
  });
});

/**
 * The console inside a compiled binary.
 *
 * `bun build --compile --asset apps/web/dist` embeds the build and names each
 * entry by its path relative to the asset directory's parent — so `dist/index.html`,
 * not `apps/web/dist/index.html`. That naming is verified against a real compiled
 * binary rather than assumed, and it is what these synthetic blobs reproduce.
 *
 * The blobs are built by hand instead of by compiling: a test that had to run
 * `bun build --compile` would take half a minute and would be testing Bun rather
 * than this module. What is under test is the lookup and the prefix rule.
 */
describe('embeddedConsole', () => {
  function embedded(entries: Record<string, string>): Blob[] {
    return Object.entries(entries).map(([name, body]) => {
      const blob = new Blob([body], { type: 'text/plain' });
      Object.defineProperty(blob, 'name', { value: name });
      return blob;
    });
  }

  it('finds the entry document and the assets beside it', () => {
    const assets = embeddedConsole(
      embedded({
        'dist/index.html': '<!doctype html>',
        'dist/assets/index-abc.js': 'console.log(1)',
      }),
    );

    expect(assets?.source).toBe('embedded');
    expect(assets?.index).not.toBeNull();
    expect(assets?.file('assets/index-abc.js')).not.toBeNull();
    // The prefix is stripped from the lookup key, so the route asks for a path
    // inside the build and not for the build's own directory name.
    expect(assets?.file('dist/assets/index-abc.js')).toBeNull();
  });

  it('answers null when there is no embedded build', () => {
    // Which is every ordinary `bun run`: `Bun.embeddedFiles` is empty there, so
    // the disk path is what a checkout uses.
    expect(embeddedConsole([])).toBeNull();
    expect(embeddedConsole(embedded({ 'dist/assets/index-abc.js': 'x' }))).toBeNull();
  });

  it('ignores anything outside the build directory', () => {
    const assets = embeddedConsole(
      embedded({
        'dist/index.html': '<!doctype html>',
        'other/secret.txt': 'not part of the console',
      }),
    );

    expect(assets?.file('other/secret.txt')).toBeNull();
    expect(assets?.file('../other/secret.txt')).toBeNull();
  });

  it('reads a file back as the bytes that went in', async () => {
    const assets = embeddedConsole(
      embedded({ 'dist/index.html': '<!doctype html>', 'dist/assets/app.css': 'body{}' }),
    );

    expect(await assets?.file('assets/app.css')?.text()).toBe('body{}');
  });
});

describe('locateConsole', () => {
  it('finds a build under the repo root', () => {
    const { repoRoot, dist } = fakeCheckout();

    const assets = locateConsole(repoRoot);
    expect(assets.source).toBe('disk');
    expect(assets.index).not.toBeNull();
    expect(assets.file('assets/index-a1b2c3.js')).not.toBeNull();
    // And nothing outside it.
    expect(assets.file('../CANARY.txt')).toBeNull();
    void dist;
  });

  it('answers an empty console when the build has not been made', () => {
    const root = mkdtempSync(join(tmpdir(), 'rutekit-nobuild-'));

    const assets = locateConsole(root);
    expect(assets.source).toBe('none');
    expect(assets.index).toBeNull();
  });

  it('answers null when the directory exists but has no entry document', () => {
    // A half-finished or interrupted build. Serving it would be a blank page with
    // no explanation; treating it as absent is the honest reading.
    const root = mkdtempSync(join(tmpdir(), 'rutekit-partial-'));
    mkdirSync(join(root, 'apps', 'web', 'dist'), { recursive: true });

    expect(locateConsole(root).index).toBeNull();
  });
});
