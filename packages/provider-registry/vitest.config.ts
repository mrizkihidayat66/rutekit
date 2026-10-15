import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The provider registry's Vitest project.
 *
 * `environment: 'node'` and nothing else from a host runtime: the package is
 * deliberately free of ambient globals (`types: []` in its tsconfig) and of
 * `node:`/`bun:` imports, so it can be exercised without a runtime standing
 * behind it. Discovery takes its HTTP client as an argument rather than reaching
 * for a global `fetch`, which is what makes that true — the tests hand it a fake
 * and never touch a socket.
 *
 * `@contracts` is aliased rather than imported as `@rutekit/contracts` because
 * that is how every other package here names it; the alias mirrors
 * `tsconfig.base.json`, so a test imports the same specifier the source does.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@contracts': fileURLToPath(
        new URL('../../packages/contracts/src/index.ts', import.meta.url),
      ),
      '@registry': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'provider-registry',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    server: {
      // Same reason as every other project here: externalising zod leaves its
      // named exports behind under this runtime, so `z` arrives `undefined`.
      deps: { inline: ['zod'] },
    },
  },
});
