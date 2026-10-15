import { defineConfig } from 'vitest/config';

/**
 * Root Vitest entry. Each workspace contributes its own project so that
 * environments stay correct per side of the boundary:
 *   - packages/*  → node
 *   - apps/web    → jsdom (React, MSW)
 *   - apps/server → node
 *   - tools/*     → node, and specifically the Node the worker actually ships on
 *                   (ADR-0009), which is why the worker is a project of its own
 *                   rather than a folder of tests inside the server
 *
 * **Coverage lives here rather than in the server's project, and it is measured
 * with `istanbul` rather than `v8`.** Both halves of that are deliberate.
 *
 * NFR-2 is a threshold on `apps/server/src` specifically, so the `include` below
 * is the server's source and nothing else: the worker, the benchmark provider and
 * the packages are not what that requirement is about, and folding them in would
 * let a well-covered package hide an uncovered route.
 *
 * The provider matters more than it looks. Under Bun, `@vitest/coverage-v8` fails
 * to convert a large share of the server's files and **reports every one of them
 * as 100% covered** — 59 of the 65 files it failed on, measured on this repo. A
 * file whose conversion failed is not a file with good coverage; it is a file
 * with no coverage at all that has been counted as perfect, and the failure is a
 * line in the console that scrolls past. Switching to `istanbul` takes conversion
 * failures to zero and moves the reported figure from 92.38% to the truth. See
 * ADR-0034.
 *
 * The threshold is on lines because that is what NFR-2 says. Branch and function
 * coverage are still reported — a number worth looking at is worth printing — but
 * they are not the gate, and gating on a number nobody chose would be inventing a
 * requirement.
 */
export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.ts',
      'apps/*/vitest.config.ts',
      'tools/*/vitest.config.ts',
    ],
    coverage: {
      provider: 'istanbul',
      // The server's own source. Anything with a test in it is excluded by the
      // default exclude list, which already drops `*.test.ts`.
      include: ['apps/server/src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: './coverage',
      thresholds: {
        lines: 85,
      },
    },
  },
});
