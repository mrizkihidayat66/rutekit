import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The web side of the frontend/backend boundary (RULESET R0.1, ADR-0003).
 *
 * The two halves of rutekit are separate applications that happen to live in one
 * repository, and the only thing allowed to pass between them is
 * `packages/contracts`. That rule is easy to state and easy to break by
 * accident — one `import { db } from '../../server/...'` in a hook, and the
 * frontend quietly depends on a Bun-only module that cannot exist in a browser.
 * The bundler will not complain until it is far too late to see why.
 *
 * So this walks the real import graph — starting at `apps/web/src`, following
 * relative imports and the Vite path aliases wherever they lead — and fails on
 * the first specifier that crosses the line. It reads specifiers with the
 * TypeScript parser rather than a regex, so a mention of "hono" in a comment is
 * not a violation and a dynamic `import()` is.
 */

// `fileURLToPath(import.meta.url)`, not `new URL('..', import.meta.url)`: this
// file imports `typescript`, which Vitest externalises, and the SSR transform
// then rewrites a `new URL(...)` expression against the dev-server base — so it
// would resolve to an `http://localhost:3000/@fs/...` URL, not a path on disk.
const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(WEB_ROOT, '..', '..');
const SRC_ROOT = join(WEB_ROOT, 'src');
const SERVER_ROOT = join(REPO_ROOT, 'apps', 'server');

/** Mirrors the `resolve.alias` block in `apps/web/vite.config.ts`. */
const ALIASES: readonly (readonly [string, string])[] = [
  ['@web', SRC_ROOT],
  ['@contracts', join(REPO_ROOT, 'packages', 'contracts', 'src', 'index.ts')],
  ['@shared', join(REPO_ROOT, 'packages', 'shared', 'src')],
];

/**
 * Bare modules the frontend must never reach, and the reason each is banned.
 *
 * The registry is on this list even though it is a `packages/` sibling rather
 * than an `apps/` one, and even though nothing in it is browser-hostile today.
 * A provider manifest is a server-side statement: it carries endpoints, auth
 * flows and the shapes of upstream responses, and the console is meant to learn
 * about a provider from the API and `@contracts` rather than from the definition
 * itself. Keeping the door shut now is what lets the registry grow fetch calls
 * and OAuth machinery later without anyone having to notice the day it stopped
 * being safe to bundle.
 */
const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
  [/^hono(\/|$)/, 'Hono is the backend framework'],
  [/^drizzle-orm(\/|$)/, 'Drizzle is the backend database layer'],
  [/^node:/, 'Node built-ins do not exist in a browser'],
  [/^bun(:|$)/, 'Bun APIs do not exist in a browser'],
  [/^playwright(-core)?(\/|$)/, 'Playwright drives the automation subprocess'],
  [/^@playwright\//, 'Playwright drives the automation subprocess'],
  [/^@rutekit\/server(\/|$)/, 'the backend package is the other side of the boundary'],
  [/^@rutekit\/provider-registry(\/|$)/, 'provider definitions are a server-side concern'],
  [/^@registry(\/|$)/, 'provider definitions are a server-side concern'],
];

/* ---- reading the graph ---- */

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  let names: string[];
  try {
    // Names only, then `isFile` to tell a directory from a file. Reading
    // `Dirent` objects instead would tie this to whichever `@types/node` is in
    // scope, and `apps/web` deliberately does not pull Node's globals in.
    names = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of names) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (isFile(full)) {
      if (/\.tsx?$/.test(name)) found.push(full);
    } else {
      found.push(...sourceFiles(full));
    }
  }
  return found;
}

/** Every module specifier in a file — static, re-exported, dynamic or required. */
function specifiersOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return ts.preProcessFile(text, true, true).importedFiles.map((reference) => reference.fileName);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Resolve a specifier to a file on disk, or `null` for a bare package name. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  for (const [alias, target] of ALIASES) {
    if (specifier === alias) return isFile(target) ? target : null;
    if (specifier.startsWith(`${alias}/`)) {
      const rest = specifier.slice(alias.length + 1);
      const base = target.endsWith('.ts') ? dirname(target) : target;
      for (const candidate of [`${join(base, rest)}.ts`, `${join(base, rest)}.tsx`, join(base, rest, 'index.ts')]) {
        if (isFile(candidate)) return candidate;
      }
      return null;
    }
  }
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

interface Edge {
  readonly from: string;
  readonly specifier: string;
  readonly resolved: string | null;
}

/** Breadth-first walk of the graph reachable from `SRC_ROOT`, inside the repo. */
function importGraph(): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const queue = sourceFiles(SRC_ROOT);

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);

    for (const specifier of specifiersOf(file)) {
      const resolved = resolveSpecifier(file, specifier);
      edges.push({ from: file, specifier, resolved });
      // Only files inside the repository are walked; node_modules is terminal.
      if (resolved !== null && resolved.startsWith(REPO_ROOT) && !seen.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return edges;
}

const graph = importGraph();
const shown = (path: string): string => relative(REPO_ROOT, path).split('\\').join('/');

/* ---- the guards ---- */

describe('web boundary', () => {
  it('walks a graph worth guarding', () => {
    // If the scan ever found nothing, every assertion below would pass by
    // default and the boundary would look enforced while being unguarded.
    expect(graph.length).toBeGreaterThan(50);
  });

  it('imports no backend-only module', () => {
    const violations: string[] = [];
    for (const { from, specifier } of graph) {
      for (const [pattern, why] of FORBIDDEN) {
        if (pattern.test(specifier)) {
          violations.push(`${shown(from)} imports "${specifier}" — ${why}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('reaches nothing under apps/server', () => {
    const violations = graph
      .filter((edge) => edge.resolved !== null && edge.resolved.startsWith(SERVER_ROOT))
      .map((edge) => `${shown(edge.from)} imports "${edge.specifier}" → ${shown(edge.resolved as string)}`);
    expect(violations).toEqual([]);
  });

  it('declares no backend-only dependency', () => {
    const manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } =
      JSON.parse(readFileSync(join(WEB_ROOT, 'package.json'), 'utf8'));
    const declared = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
    const violations = declared.filter((name) => FORBIDDEN.some(([pattern]) => pattern.test(name)));
    expect(violations).toEqual([]);
  });
});
