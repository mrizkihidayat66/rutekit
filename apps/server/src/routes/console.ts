import { existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '@server/types.ts';

/**
 * Serving the built console from the same process as the API (D3).
 *
 * Until D3 nothing did. In development Vite serves the console and proxies
 * `/console/api`, `/v1` and `/ws` to the server, which is why the gap was
 * invisible: every test and every manual check ran behind Vite. A compiled
 * binary, a Docker image, or `bunx rutekit` has no Vite in front of it, so each
 * of them started a server whose root path answered 404 — an API with no console.
 *
 * **It is registered last, and that is the whole ordering story.** Hono matches
 * in registration order, so every API route wins before this one is consulted.
 * What is left for this module is exactly what nothing else claimed: the console's
 * own files and the client-side routes.
 *
 * **The reserved prefixes are refused explicitly rather than left to ordering.**
 * A request for `/console/api/nope` matches no route, and without this it would
 * fall through to the SPA fallback and be answered with `index.html` — a 200 with
 * HTML where the console's client expects a JSON error envelope. The client would
 * report "response did not match its contract" on a path that simply does not
 * exist, which is the least useful version of that failure.
 *
 * **Caching is not an optimisation here, it is correctness.** The abuse guard
 * counts every request per address with a ceiling of 600 a minute, and a console
 * page load is on the order of fifty requests. Without caching, reloading a few
 * times in a minute competes with the protection that exists to stop an attacker.
 * Vite content-hashes everything under `assets/`, so those are immutable and the
 * browser keeps them; `index.html` must not be, or a deploy would never be picked
 * up. With that, a repeat visit costs one request.
 *
 * ## Two places the console can live, and one of them is inside the binary
 *
 * A checkout has `apps/web/dist` on disk. A **compiled binary has no checkout** —
 * it is one file, and a build that embedded nothing serves an API-only server
 * whose root path 404s, which is exactly the bug this module was written to fix
 * and which it did not fix for the binary until D4.
 *
 * `bun build --compile --asset <dir>` embeds a directory and preserves the path
 * relative to the directory's own parent — so `--asset apps/web/dist` produces
 * names like `dist/index.html`. `Bun.embeddedFiles` is an empty array in an
 * ordinary `bun run`, which is what makes "is this a binary?" answerable without
 * a flag: if it has entries, the console is in them.
 *
 * Both are read through the same interface, so the route does not know which it
 * is serving from — and a `Blob` is what `Bun.file()` returns anyway, so the two
 * paths hand back the same type.
 */

/** The paths the server owns, which the console must never answer for. */
const RESERVED: readonly string[] = ['/console/api', '/v1', '/ws', '/healthz', '/readyz'];

function isReserved(pathname: string): boolean {
  return RESERVED.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Content types, by extension.
 *
 * A short table rather than a lookup library: this serves one build output, and
 * the list of extensions a Vite build produces is closed and small. Anything not
 * here is served as `application/octet-stream`, which a browser downloads rather
 * than executes — the safe default for a type nobody anticipated.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function typeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * The console's files, wherever they are.
 *
 * `index` is null when there is no console at all, which is what the route uses
 * to decide whether to register itself. `file` answers null for anything not in
 * the build, so the caller falls back to the entry document.
 */
export interface ConsoleAssets {
  /** The entry document, or null when this instance has no console. */
  readonly index: Blob | null;
  /** One file by its path inside the build, e.g. `assets/index-abc123.js`. */
  file(relative: string): Blob | null;
  /** Where it came from, for a log line. */
  readonly source: 'embedded' | 'disk' | 'none';
}

export const NO_CONSOLE: ConsoleAssets = {
  index: null,
  file: () => null,
  source: 'none',
};

/** The prefix `bun build --compile --asset <dir>` gives the embedded names. */
const EMBEDDED_PREFIX = 'dist/';

/**
 * The console embedded in a compiled binary, or null when there is none.
 *
 * `Bun.embeddedFiles` is empty in an ordinary run, so this answers null there and
 * the disk path below is what a checkout uses.
 */
export function embeddedConsole(files: readonly Blob[] = Bun.embeddedFiles): ConsoleAssets | null {
  const byPath = new Map<string, Blob>();
  for (const file of files) {
    const name = (file as unknown as { name?: string }).name;
    if (name === undefined || !name.startsWith(EMBEDDED_PREFIX)) continue;
    byPath.set(name.slice(EMBEDDED_PREFIX.length), file);
  }

  const index = byPath.get('index.html');
  if (index === undefined) return null;

  return {
    index,
    file: (relative) => byPath.get(relative) ?? null,
    source: 'embedded',
  };
}

/**
 * A file inside a build on disk, or null.
 *
 * Two steps, and both are load-bearing.
 *
 * **Leading separators are stripped before the join.** A pathname always begins
 * with `/`, and joining that directly produces `//…` — which on Windows is a UNC
 * prefix, so `normalize` turns `//../x` into a UNC-shaped nonsense path instead
 * of resolving it. Stripping first makes the remainder the relative path `resolve`
 * is being asked to interpret.
 *
 * **The result is checked against the root**, with `sep` appended so a sibling
 * directory sharing a name prefix (`dist-other`) cannot pass. This is what makes
 * `../` inert.
 *
 * That second check is **defence in depth rather than the first line**, and that
 * is worth stating because it changes what a test can prove: `new URL(...).pathname`
 * has already collapsed `..` before this function is called, so a real request
 * cannot reach here with a traversal in it. The check exists because the layer
 * that normalises today is one refactor away from not doing so. It is tested
 * directly rather than through a request, because through a request it is
 * unreachable.
 */
export function fileWithin(root: string, relative: string): string | null {
  const cleaned = relative.replace(/^[/\\]+/, '');
  if (cleaned === '') return null;

  const candidate = resolve(root, cleaned);
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;

  try {
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/** The console in a build directory, or null when it is not there. */
export function diskConsole(root: string): ConsoleAssets | null {
  const index = join(root, 'index.html');
  if (!existsSync(index) || !statSync(index).isFile()) return null;

  return {
    index: Bun.file(index),
    file: (relative) => {
      const path = fileWithin(root, relative);
      return path === null ? null : Bun.file(path);
    },
    source: 'disk',
  };
}

/**
 * Find the console: embedded first, then on disk, then not at all.
 *
 * Embedded wins because a compiled binary is the only thing that has one, and a
 * binary sitting next to a checkout is a case where the *binary's* console is the
 * one that matches its code.
 *
 * On disk there are two places to look, because there are two ways to ship a build:
 * inside a checkout, and beside a bundled package. The second is relative to this
 * module rather than to the repository root, because a published package has no
 * checkout to be relative to — and in a checkout that path does not exist, so the
 * extra lookup costs nothing there.
 */
export function locateConsole(repoRoot: string): ConsoleAssets {
  return (
    embeddedConsole() ??
    diskConsole(join(repoRoot, 'apps', 'web', 'dist')) ??
    bundledConsole() ??
    NO_CONSOLE
  );
}

/**
 * The console shipped beside a bundle, or null where there is no such directory.
 *
 * `import.meta.dir` is absent under the test runner, which replaces `import.meta` with
 * an object of its own — the same reason `resolvePromptfooPackage` uses `createRequire`
 * rather than `import.meta.resolve`. So a runtime without it answers null here instead
 * of throwing, and the checkout path above is what the tests exercise.
 */
function bundledConsole(): ConsoleAssets | null {
  const dir: string | undefined = import.meta.dir;
  return typeof dir === 'string' ? diskConsole(join(dir, 'console')) : null;
}

/** Hashed build output never changes under the same name; the entry document always might. */
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

function serveFile(blob: Blob, path: string, headers: Readonly<Record<string, string>>): Response {
  return new Response(blob, { headers: { 'content-type': typeOf(path), ...headers } });
}

/** The pathname, decoded, or null when it is not valid percent-encoding. */
function decodedPathname(url: string): string | null {
  const { pathname } = new URL(url);
  try {
    return decodeURIComponent(pathname);
  } catch {
    // `decodeURIComponent('%')` throws. A malformed escape is a client error, not
    // a reason to fall over — and an unhandled throw here would be a 500 for a
    // request that only got the encoding wrong.
    return null;
  }
}

export function consoleRoutes(app: Hono<AppEnv>, assets: ConsoleAssets): void {
  if (assets.index === null) return;
  const index = assets.index;

  app.get('*', (c: Context<AppEnv>) => {
    const pathname = decodedPathname(c.req.url);
    if (pathname === null) return c.notFound();
    if (isReserved(pathname)) return c.notFound();

    // A real file under the build wins. `index.html` itself is deliberately
    // excluded from this branch so that it always goes out with the revalidate
    // header rather than the immutable one.
    if (pathname !== '/') {
      const relative = pathname.replace(/^[/\\]+/, '');
      const file = relative === 'index.html' ? null : assets.file(relative);
      if (file !== null) return serveFile(file, pathname, { 'cache-control': IMMUTABLE });
    }

    // The SPA fallback: every client-side route (`/cli-tools`, `/settings`) is a
    // path that exists only in the browser's router, and a reload on one must not
    // be a 404.
    return serveFile(index, 'index.html', { 'cache-control': REVALIDATE });
  });
}
