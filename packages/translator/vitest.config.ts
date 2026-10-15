import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The translator's Vitest project.
 *
 * Pure, like the provider registry: no `node:`/`bun:` import and no ambient
 * global, so the whole package is exercised without a runtime standing behind it.
 * Nothing here opens a socket — a codec takes bytes and returns values.
 *
 * The aliases mirror `tsconfig.base.json` in shape as well as in target, so a
 * test imports the specifier the source does and a subpath like
 * `@contracts/surfaces/chat-completions.ts` resolves.
 */
const root = dirname(fileURLToPath(import.meta.url));
const src = (relative: string): string => resolve(root, relative);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@contracts$/, replacement: src('../../packages/contracts/src/index.ts') },
      { find: /^@contracts\/(.*)$/, replacement: src('../../packages/contracts/src/$1') },
      { find: /^@shared$/, replacement: src('../../packages/shared/src/index.ts') },
      { find: /^@shared\/(.*)$/, replacement: src('../../packages/shared/src/$1') },
      { find: /^@translator$/, replacement: src('./src/index.ts') },
      { find: /^@translator\/(.*)$/, replacement: src('./src/$1') },
    ],
  },
  test: {
    name: 'translator',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    server: {
      // Same reason as every other project here: externalising zod leaves its
      // named exports behind under this runtime, so `z` arrives `undefined`.
      deps: { inline: ['zod'] },
    },
  },
});
