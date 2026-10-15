/**
 * Whether the console talks to the mock layer or to the real server.
 *
 * **The real server is the default.** FASE B built the whole console against MSW
 * because there was no backend yet; FASE C built the backend, and D4 finished
 * wiring the two together. Leaving the mocks on by default past that point means
 * the console a developer sees is a *different* console from the one an operator
 * gets — every fixture is a claim about what the server answers, and a claim
 * nothing checks until someone runs it for real.
 *
 * So mocks are now opt-in: `VITE_MOCKS=on` starts the worker, and anything else
 * (including unset) sends every request to the network, which in dev is the Vite
 * proxy and therefore the real server.
 *
 * **Why an escape hatch at all.** Two reasons worth keeping it for. A frontend
 * change that should not need a running server — styling, layout, a component —
 * can still be worked on with one command. And a page whose endpoint is broken
 * can be compared against a known-good fixture to tell a rendering bug from a
 * data bug.
 *
 * **All or nothing, not per domain.** Until this change the switch was
 * `VITE_LIVE_DOMAINS`, which sent the named domains to the server and left the
 * rest mocked — machinery for migrating one domain at a time as each backend
 * landed. Every domain has landed, so that switch had nothing left to express,
 * and a half-mocked console is a debugging trap: the answer you get depends on
 * which page you opened.
 *
 * This module is imported **eagerly** by `main.tsx` to decide whether to start
 * the worker at all, so it must not import anything from `mocks/` — reaching the
 * handler barrel would drag MSW and every fixture into the production bundle,
 * which is the one thing the dynamic import in `main.tsx` exists to prevent
 * (NFR-9).
 */

/** The values that turn the mock layer on. Anything else leaves it off. */
const ON = new Set(['on', 'true', '1']);

export const mocksEnabled: boolean =
  import.meta.env.DEV && ON.has((import.meta.env.VITE_MOCKS ?? '').toLowerCase());

/** Said once at boot, so a console that is mocked cannot be mistaken for one that is not. */
export const MOCKS_ENABLED_NOTICE =
  '[rutekit] VITE_MOCKS=on — every request is answered by the mock layer, not by the server.';
