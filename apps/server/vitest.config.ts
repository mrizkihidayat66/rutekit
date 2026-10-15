import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The server's Vitest project.
 *
 * Runs under Bun (`bun --bun vitest run`, which the root `test` script uses):
 * the server imports `bun:sqlite` and `hono/bun`, and neither exists in Node, so
 * a Node-hosted run cannot even load the persistence tests. The aliases mirror
 * `tsconfig.base.json`, so a test imports the same specifier the source does.
 *
 * They mirror it in shape as well as in target: `tsconfig.base.json` declares
 * both `@registry` and `@registry/*`, and the registry package's `exports` map
 * advertises `./*` to match, so `@registry/providers/index.ts` is a supported
 * specifier. An exact-match alias would resolve `@registry` and then fail on the
 * subpath, which is a resolution failure the type checker would never report.
 */
const root = dirname(fileURLToPath(import.meta.url));
const src = (relative: string): string => resolve(root, relative);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@server$/, replacement: src('./src') },
      { find: /^@server\/(.*)$/, replacement: src('./src/$1') },
      { find: /^@contracts$/, replacement: src('../../packages/contracts/src/index.ts') },
      { find: /^@contracts\/(.*)$/, replacement: src('../../packages/contracts/src/$1') },
      { find: /^@registry$/, replacement: src('../../packages/provider-registry/src/index.ts') },
      { find: /^@registry\/(.*)$/, replacement: src('../../packages/provider-registry/src/$1') },
      { find: /^@shared$/, replacement: src('../../packages/shared/src') },
      { find: /^@shared\/(.*)$/, replacement: src('../../packages/shared/src/$1') },
      { find: /^@translator$/, replacement: src('../../packages/translator/src/index.ts') },
      { find: /^@translator\/(.*)$/, replacement: src('../../packages/translator/src/$1') },
      { find: /^@compression$/, replacement: src('../../packages/compression/src/index.ts') },
      { find: /^@compression\/(.*)$/, replacement: src('../../packages/compression/src/$1') },
    ],
  },
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    server: {
      // Zod is a dual CJS/ESM package, and the runtime's interop for an
      // externalised dependency does not carry its named exports — `z` arrives
      // as `undefined` and the first `z.object(...)` throws. Inlining it makes
      // Vite transform it instead of handing it to the runtime, which is the
      // same code path the bundler takes for the browser build.
      deps: { inline: ['zod'] },
    },
  },
});
