import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';

import { server } from '../src/mocks/server.ts';

/**
 * The web test environment.
 *
 * The console is built against MSW, so a test that renders a page gets the same
 * fixtures the browser does — through the same handlers, over the same paths.
 * `server.ts` binds the raw handlers rather than the ones `net.ts` wraps, so a
 * test never inherits the latency or the scenario switch the dev flipper last
 * left on: it is deterministic by construction.
 *
 * `onUnhandledRequest: 'error'` is the strict setting on purpose. A test that
 * reaches a route the mock layer does not cover should fail loudly, because the
 * same gap would be a blank page in the browser.
 */
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
  cleanup();
});

afterAll(() => {
  server.close();
});

/**
 * jsdom ships no `matchMedia`, and `lib/theme.ts` calls it on the first render,
 * so every page test would throw without this stub. The query is answered "light"
 * — the OS preference is not what any of these tests are about.
 */
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  });
}
