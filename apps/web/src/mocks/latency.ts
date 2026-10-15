/**
 * The mock layer's scenario switch.
 *
 * Building a page against a mock that always answers instantly in 200 leaves
 * three of its four states unverified: the skeleton, the empty table and the
 * error panel. This flips the whole console into one of those states so each
 * page can be walked through them without editing handlers.
 *
 *   normal   a realistic, slightly jittery round-trip
 *   slow     a uniform two-second stall, for testing spinners and timeouts
 *   loading  responses never arrive, so the loading state stays put
 *   empty    list bodies are rewritten to an empty page
 *   error    every request fails with a 503 console error
 *
 * Set it from the URL (`?mock=error`) or from the dev flipper in the corner.
 * Tests never use this: `server.ts` wires the raw handlers, so a test is
 * deterministic regardless of what the browser was last left on.
 */

export type MockMode = 'normal' | 'slow' | 'loading' | 'empty' | 'error';

const MODES: readonly MockMode[] = ['normal', 'slow', 'loading', 'empty', 'error'];

function isMode(value: string | null): value is MockMode {
  return value !== null && (MODES as readonly string[]).includes(value);
}

function fromUrl(): MockMode {
  if (typeof window === 'undefined') return 'normal';
  const value = new URLSearchParams(window.location.search).get('mock');
  return isMode(value) ? value : 'normal';
}

let current: MockMode = fromUrl();

export function mockMode(): MockMode {
  return current;
}

export function setMockMode(mode: MockMode): void {
  current = mode;
}

/** Milliseconds to wait, or `null` for "never resolve". */
export function mockLatency(mode: MockMode): number | null {
  switch (mode) {
    case 'loading':
      return null;
    case 'slow':
      return 2_000;
    case 'empty':
    case 'error':
      return 0;
    case 'normal':
      return 120 + Math.round(Math.random() * 280);
  }
}
