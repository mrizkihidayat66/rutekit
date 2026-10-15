import { defineConfig } from 'vitest/config';

/**
 * The worker's own suite.
 *
 * `node`, not `jsdom` and not Bun: this package is the one place rutekit runs on
 * Node (ADR-0009), and a test that ran under a different runtime would be testing
 * something other than what ships.
 *
 * The zod inline is the same one `packages/contracts` and `apps/server` carry.
 * The worker does not import zod itself — it validates frames with the schemas
 * `@rutekit/contracts` exports — but those schemas are built by zod at module
 * load, and an externalised zod under this runtime leaves its named exports
 * behind: `z` arrives `undefined` and the first `z.object(...)` throws before a
 * single test runs.
 */
export default defineConfig({
  test: {
    name: 'automation-worker',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    server: {
      deps: { inline: ['zod'] },
    },
  },
});
