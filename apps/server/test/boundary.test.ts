import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The server side of the frontend/backend boundary (RULESET R0.1, ADR-0003).
 *
 * The mirror of `apps/web/test/boundary.test.ts`: the backend must not reach
 * into the frontend, and must not grow a React dependency. Both directions are
 * checked because only checking one leaves the boundary enforceable from a
 * single side — and the failure it prevents (a Bun-only module pulled into the
 * browser bundle, or a component pulled into the server) is exactly the kind
 * that survives review and breaks at build time.
 *
 * The backend is a skeleton in FASE A, so the source scan has little to read
 * yet; it becomes substantive the moment FASE C adds code, without any change
 * here. The manifest and `.tsx` checks are already real.
 */

// `fileURLToPath(import.meta.url)`, not `new URL('..', import.meta.url)`: this
// file imports `typescript`, which Vitest externalises, and the SSR transform
// then rewrites a `new URL(...)` expression against the dev-server base — so it
// would resolve to an `http://localhost:3000/@fs/...` URL, not a path on disk.
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(SERVER_ROOT, '..', '..');
const WEB_ROOT = join(REPO_ROOT, 'apps', 'web');

/** Bare modules the backend must never reach, and the reason each is banned. */
const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
  [/^react(\/|$)/, 'React belongs to the frontend'],
  [/^react-dom(\/|$)/, 'react-dom belongs to the frontend'],
  [/^@testing-library\//, 'component testing belongs to the frontend'],
  [/^@rutekit\/web(\/|$)/, 'the web package is the other side of the boundary'],
  [/^msw(\/|$)/, 'MSW is the frontend mock layer; the server serves real traffic'],
];

/* ---- reading the graph ---- */

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  let names: string[];
  try {
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

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

interface Edge {
  readonly from: string;
  readonly specifier: string;
  readonly resolved: string | null;
}

function importGraph(): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const queue = sourceFiles(SERVER_ROOT);

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);

    for (const specifier of specifiersOf(file)) {
      const resolved = resolveSpecifier(file, specifier);
      edges.push({ from: file, specifier, resolved });
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

describe('server boundary', () => {
  it('imports no frontend-only module', () => {
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

  it('reaches nothing under apps/web', () => {
    const violations = graph
      .filter((edge) => edge.resolved !== null && edge.resolved.startsWith(WEB_ROOT))
      .map((edge) => `${shown(edge.from)} imports "${edge.specifier}" → ${shown(edge.resolved as string)}`);
    expect(violations).toEqual([]);
  });

  it('declares no frontend-only dependency', () => {
    const manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } =
      JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8'));
    const declared = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
    const violations = declared.filter((name) => FORBIDDEN.some(([pattern]) => pattern.test(name)));
    expect(violations).toEqual([]);
  });

  it('contains no component file', () => {
    // A `.tsx` file in the backend means a component or a hook, and either one
    // would drag React in. This holds today and is the check that stays useful
    // while the source scan is still reading an empty skeleton.
    const components = sourceFiles(SERVER_ROOT).filter((file) => file.endsWith('.tsx'));
    expect(components.map(shown)).toEqual([]);
  });
});
