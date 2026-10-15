import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The real server, for the domains that have gone live (see
 * `src/mocks/live-domains.ts`). Same origin from the browser's point of view, so
 * no CORS preflight and no cookie/`SameSite` special-casing in dev — the app is
 * written as if it were served by Hono, because in production it will be.
 *
 * `RUTEKIT_PORT` is read from the shell, not from `.env`: Vite does not load env
 * files into `process.env` for its own config. Export it if the server is not on
 * the default port.
 */
const SERVER_ORIGIN = `http://127.0.0.1:${process.env.RUTEKIT_PORT ?? '7331'}`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@web': fileURLToPath(new URL('./src', import.meta.url)),
      '@contracts': fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
      '@shared': fileURLToPath(new URL('../../packages/shared/src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      // The console control plane.
      '/console/api': { target: SERVER_ORIGIN, changeOrigin: true },
      // The OpenAI-compatible router surface clients talk to.
      '/v1': { target: SERVER_ORIGIN, changeOrigin: true },
      // Live console updates. `ws: true` is what makes the upgrade survive.
      '/ws': { target: SERVER_ORIGIN, ws: true, changeOrigin: true },
    },
  },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
});
