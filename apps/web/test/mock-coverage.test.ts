import { CONSOLE_API_PREFIX, consolePaths } from '@contracts';
import { describe, expect, it } from 'vitest';

import { handlers } from '@web/mocks/handlers/index.ts';

/**
 * The mock layer's own guard.
 *
 * The frontend is built before the backend, so the mock handlers *are* the API
 * for now. If a page starts calling a path that no handler serves, the failure
 * is a blank screen in the browser and an opaque "unhandled request" in a test —
 * far from the line that caused it. This test moves that failure to here, where
 * it names the exact path, and it runs on every `bun run test`.
 *
 * It compares the handler set against `consolePaths` — the contract's own list —
 * so it stays honest as the API grows: adding a path to `packages/contracts`
 * without a handler fails this test rather than shipping.
 */

/**
 * Paths the real server answers, and for which no mock handler is expected.
 *
 * The mocks are now an opt-in escape hatch rather than the default (see
 * `src/mocks/mock-mode.ts`), so nothing is being migrated off this list any more
 * — it holds the two paths the server answers and no page reads. A path here is
 * not a gap in the guard: the guard still means what it says, because a path
 * that is neither mocked nor served by the server is still a page calling into
 * nothing.
 */
const SERVER_SERVED: readonly string[] = [
  `${CONSOLE_API_PREFIX}${consolePaths.meta}`,
  // Exporting a conversation (C9, FR-7.7). The server answers it and nothing in
  // the console asks for it yet — there is no button — so a mock would be a
  // second rendering of a transcript that no page reads.
  `${CONSOLE_API_PREFIX}${consolePaths.chatExport}`,
];

const expectedPaths = new Set(
  Object.values(consolePaths)
    .map((template) => `${CONSOLE_API_PREFIX}${template}`)
    .filter((path) => !SERVER_SERVED.includes(path)),
);

const rawPaths = handlers.map((handler) => handler.info.path);
const declaredPaths = rawPaths.filter((path): path is string => typeof path === 'string');

describe('mock coverage', () => {
  it('builds every route from a plain string path', () => {
    // A RegExp or a predicate path could not be checked against `consolePaths`,
    // so the whole guard below would quietly stop meaning anything.
    expect(declaredPaths).toHaveLength(rawPaths.length);
  });

  it('handles every path in the console contract', () => {
    const handled = new Set(declaredPaths);
    const missing = [...expectedPaths].filter((path) => !handled.has(path));
    expect(missing).toEqual([]);
  });

  it('serves nothing outside the console contract', () => {
    const extra = declaredPaths.filter((path) => !expectedPaths.has(path));
    expect(extra).toEqual([]);
  });

  it('registers no two handlers on the same method and path', () => {
    // MSW resolves to the first match, so a duplicate would silently shadow the
    // later handler — the page would keep seeing stale behaviour with no error.
    const keys = handlers.map(
      (handler) => `${String(handler.info.method)} ${String(handler.info.path)}`,
    );
    const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index);
    expect(duplicates).toEqual([]);
  });
});
