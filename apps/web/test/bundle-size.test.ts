import { existsSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What the console costs to open (NFR-9).
 *
 * NFR-9 caps the initial bundle at 300 KB gzip. That number is about *the first
 * paint*: a page that loads is a page the operator is looking at, and everything
 * else can arrive later. So this measures exactly what `index.html` pulls —
 * not the whole `dist`, which includes the lazy route chunks, Monaco, mermaid and
 * the three.js viewer and is two orders of magnitude larger.
 *
 * **The eager imports are the thing to watch.** The initial chunk grows when
 * something reaches the module graph statically: a new shell dependency, a
 * component that stops being lazily imported, a fixture that sneaks into a
 * barrel. None of those look like a bundle change at review time. This test is
 * the only place the cost shows up before an operator feels it.
 *
 * It skips when there is no build, because `apps/web/dist` is a build artefact
 * and a checkout that has not run `bun run build` legitimately has none — the
 * alternative is a test that fails on a fresh clone.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '..', 'dist');
const INDEX = join(DIST, 'index.html');

/** NFR-9, in bytes. */
const BUDGET = 300 * 1024;

/** The files the entry document loads eagerly — scripts and stylesheets. */
function initialAssets(): { readonly name: string; readonly bytes: number }[] {
  const html = readFileSync(INDEX, 'utf8');
  const refs = new Set<string>();
  for (const [, url] of html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)) {
    if (url !== undefined) refs.add(url);
  }

  return [...refs].map((ref) => {
    const path = join(DIST, ref);
    return { name: ref, bytes: gzipSync(readFileSync(path)).byteLength };
  });
}

describe.skipIf(!existsSync(INDEX))('the initial bundle', () => {
  it('loads at least one script and one stylesheet', () => {
    // If the extraction ever stopped finding anything, the budget assertion
    // below would pass by measuring nothing.
    const assets = initialAssets();
    expect(assets.length).toBeGreaterThanOrEqual(2);
    expect(assets.some((a) => a.name.endsWith('.js'))).toBe(true);
    expect(assets.some((a) => a.name.endsWith('.css'))).toBe(true);
  });

  it('fits in the NFR-9 budget, gzipped', () => {
    const assets = initialAssets();
    const total = assets.reduce((sum, asset) => sum + asset.bytes, 0);
    const detail = assets
      .map((a) => `${a.name.split('/').pop() ?? a.name} ${String(Math.round(a.bytes / 1024))}KB`)
      .join(', ');

    expect(
      total,
      `initial load is ${String(Math.round(total / 1024))}KB gzip (${detail}); NFR-9 allows ${String(BUDGET / 1024)}KB`,
    ).toBeLessThan(BUDGET);
  });

  it('keeps the heavy editors and renderers out of the initial load', () => {
    // Monaco, mermaid and the graph libraries are the largest things in the app
    // and every one of them is behind a lazy route. A static import anywhere in
    // the eager graph would pull them in, and this is what says so by name
    // rather than as a budget that drifted a little.
    const names = initialAssets().map((asset) => asset.name);
    for (const heavy of ['JsonEditor', 'mermaid', 'cytoscape', 'wasm']) {
      expect(
        names.some((name) => name.includes(heavy)),
        `${heavy} is in the initial load`,
      ).toBe(false);
    }
  });

  it('ships sourcemaps without letting them into the entry document', () => {
    // Sourcemaps are a build setting (`vite.config.ts`), and they are served
    // beside the chunks rather than referenced by the HTML — so they cost disk,
    // not first paint. Asserting they exist keeps a future `sourcemap: false`
    // from being a silent change to how a production bug gets debugged.
    const html = readFileSync(INDEX, 'utf8');
    expect(html).not.toContain('.map');
    const js = initialAssets().find((asset) => asset.name.endsWith('.js'));
    expect(js).toBeDefined();
    expect(existsSync(join(DIST, `${js?.name ?? ''}.map`))).toBe(true);
  });

  it('has a non-empty entry chunk, so the budget is not measuring an empty file', () => {
    const js = initialAssets().find((asset) => asset.name.endsWith('.js'));
    const bytes = statSync(join(DIST, js?.name ?? '')).size;
    expect(bytes).toBeGreaterThan(10_000);
  });
});
