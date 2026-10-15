import { setupWorker } from 'msw/browser';

import { handlers } from './handlers/index.ts';
import { MOCKS_ENABLED_NOTICE } from './mock-mode.ts';
import { activateScenarios } from './net.ts';

/**
 * The browser mock worker.
 *
 * Started once from `main.tsx`, before the app renders, so the very first query a
 * page fires is already intercepted — starting it after the first paint would let
 * one request escape and reach a server that is not there.
 *
 * Reached only when `VITE_MOCKS=on`: the real server is the default, and
 * `main.tsx` takes the dynamic import that loads this file only in that case. So
 * MSW and every fixture stay out of the bundle an operator loads (NFR-9).
 *
 * This is also the only place the scenario layer is switched on: latency, the
 * failure injection and the empty-page rewriting are a browser affordance for
 * looking at a page's loading and error states, and tests run without them.
 */
activateScenarios();

export const worker = setupWorker(...handlers);

export async function startMockWorker(): Promise<void> {
  // Said out loud, once. A console answering from fixtures looks exactly like one
  // answering from a server, and the difference matters the moment somebody is
  // debugging why a change "did not take".
  // eslint-disable-next-line no-console
  console.info(MOCKS_ENABLED_NOTICE);

  await worker.start({
    // Anything the console does not own — Vite's own module and HMR traffic — is
    // left alone, and left alone quietly.
    onUnhandledRequest: 'bypass',
    serviceWorker: { url: '/mockServiceWorker.js' },
  });
}
