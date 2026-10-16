# `web`

The operator console — the React 19 + Vite application an operator uses to run and inspect
the router. It is the browser half of rutekit, and it never learns the server half exists.

## What it owns

Everything the browser runs: the shell, the pages, the data layer, the design tokens and
the mock layer that can stand in for the API. It reaches the backend only through
`@rutekit/contracts` and the `/console/api` routes, proxied by `vite.config.ts`.

## The files that matter

- **`test/boundary.test.ts`** — the frontend/backend boundary (R0.1, ADR-0003). It walks
  the real import graph from `src/` with the TypeScript parser and fails on any `hono`,
  `drizzle-orm`, `node:`, `bun`, Playwright, `@rutekit/server`, `@rutekit/provider-registry`
  or `@registry` import, or any of those declared in `package.json`.
- **`src/data/client.ts`** — the one place the console touches the network (R6.1).
  `apiRequest` validates every response against the contract's schema and turns a non-2xx
  into a typed `ApiError`; `query-keys.ts` beside it builds every TanStack Query key from
  the contract's query types.
- **`src/mocks/mock-mode.ts`** — whether the console talks to the mock layer. `VITE_MOCKS=on`
  (or `true`/`1`) starts it; anything else, including unset, sends every request to the
  real server. `main.tsx` imports `mocks/browser.ts` dynamically and only then, so MSW
  stays out of the production bundle (NFR-9).
- **`src/styles/app.css`** — the source of truth for the visual language: tokens live in
  Tailwind's `@theme`, and dark mode re-binds the same names under the dark selector.
- **`test/contrast.test.ts`** — computes WCAG contrast from the tokens themselves, because
  `jsdom` has no layout or colour compositing, so an axe run cannot see contrast at all.
- **`src/shell/AppShell.tsx`** — the OS-style frame: a rail and a window, each a floating
  card, with the window owning the only scroller in the app.
- **`src/routes/route-table.tsx`** — the routing graph; every page is a lazy chunk (R6.3).

## Invariants and traps

- **The boundary is walked, not trusted.** `boundary.test.ts` reads the graph rather than
  a list, so a transitive import that crosses the line fails even when no file in
  `apps/web` names the forbidden module.
- **`src/data/` was once invisible to git.** A bare `data/` in the root `.gitignore`
  matched at any depth and silently excluded the real source files under
  `apps/web/src/data/`, so a fresh clone could not build. The rule is now anchored.
- **Mocks are opt-in, and the default is the server.** Leaving them on makes the console a
  developer sees a different console from an operator's, every fixture an unchecked claim
  about the API. The layer survives to work without a running server and to separate a
  rendering bug from a data bug.
- **Every contract path has a mock handler, and copies are pinned to the contract.**
  `mock-coverage.test.ts` compares the handler set against `consolePaths`, so a path added
  to `packages/contracts` without a handler fails rather than shipping; `parity.test.ts`
  pins the usage breakdown dimensions and the provider icon slugs the same way.
- **MSW matches in registration order.** A specific path is registered before the
  collection it belongs to, or it swallows the literal routes beside it.
- **Tokens are the only source of visual values.** `eslint-plugin-rutekit` rejects
  hardcoded colour, radius and duration literals and any `style={{}}` that is not purely a
  map of CSS custom properties.
- **The bundle gate skips itself when there is no build.** `bundle-size.test.ts` is skipped
  when `apps/web/dist` is absent, so it passes on a checkout that never ran `bun run
build` — which is why CI builds before it tests.
- **The shell grid has no max-width on purpose.** A capped shell leaves dead margins on
  wide monitors; pages constrain their own content so data-dense views can use the whole
  canvas.
