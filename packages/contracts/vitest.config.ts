import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'contracts',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    server: {
      // See the note in `apps/server/vitest.config.ts`: externalising zod leaves
      // its named exports behind under this runtime.
      deps: { inline: ['zod'] },
    },
  },
});
