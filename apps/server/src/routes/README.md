# `routes`

The HTTP surface: one thin Hono module per domain, wired into two namespaces in `app.ts`.

## What it owns

The boundary between HTTP and the services. A route parses a query, validates a body,
calls a service, and returns its answer — nothing else (R5.2). Business logic lives in the
folder that owns the concern (`accounts/`, `pool/`, `chat/`, …); if you are tempted to put
a decision in a route, it belongs in the service.

## The files that matter

- **`console.ts`** — not a route group in the usual sense: it locates and serves the built
  console (embedded in a compiled binary, or on disk), with the SPA fallback. Registered
  **last**.
- **`v1.ts`** — the data plane: five routes, each one line of translation around
  `providers/dispatcher.ts`.
- **`health.ts`** — `/healthz` (alive) and `/readyz` (accepting work). Outside both
  namespaces.
- **`meta.ts`** — what the server says about itself; reads the boot timestamp and schema
  version back out of SQLite, so a 200 proves the whole path.
- The rest map one-to-one onto console sections: `auth`, `api-keys`, `providers`,
  `accounts`, `routing`, `token-saver`, `overview`, `automation`, `jobs`, `tools`, `chat`,
  `studio`, `benchmark`, `verification`, `system`.

## Invariants and traps

- **Literal paths are registered before `:id` routes.** Hono matches in registration
  order, so `/mappings/preview` must precede `/mappings/:id`, `/accounts/bulk` before
  `/accounts/:id`, `vcc/bins` before `vcc/:id`, and so on. Several file headers say this;
  it is the single most common trap here.
- **Every route with input validates it.** Use `jsonBody(schema)` from
  `ingress/validate.ts` for bodies; parse queries with `schema.safeParse` and throw
  `AppError.invalidRequest` — an unvalidated `sort` or `state` reaching a comparison is a
  bug (R5.1).
- **`consoleRoutes` is registered last and refuses reserved prefixes explicitly**
  (`/console/api`, `/v1`, `/ws`, `/healthz`, `/readyz`). Without that, an unknown API path
  would fall through to the SPA fallback and be answered with `index.html`.
- **All console routes sit behind the session guard** (mounted in `app.ts`); all `/v1`
  routes sit behind the API-key guard. A route must not assume the other's context.
- **`v1.ts` reads the API-key row back** rather than trusting the guard's id alone — the
  dispatcher needs the key's scope lists, which only the row has.
- **The studio file route is the only one that answers with bytes**; its path safety is
  built in `studio/storage.ts`, not in the handler.
