import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The compression package's Vitest project.
 *
 * It reaches for `@translator` rather than re-declaring the canonical shape,
 * because a stage reads and writes that shape and a second copy of it would be a
 * second thing to keep in step.
 *
 * The aliases mirror `tsconfig.base.json`, so a test imports what the source does.
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
      { find: /^@translator$/, replacement: src('../../packages/translator/src/index.ts') },
      { find: /^@translator\/(.*)$/, replacement: src('../../packages/translator/src/$1') },
      { find: /^@compression$/, replacement: src('./src/index.ts') },
      { find: /^@compression\/(.*)$/, replacement: src('./src/$1') },
    ],
  },
  test: {
    name: 'compression',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    server: {
      deps: { inline: ['zod'] },
    },
  },
});
