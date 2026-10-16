# `contracts`

The schemas, and the types derived from them, that both halves of rutekit share — the
one module a web file and a server file may both import (RULESET R0.1, R0.3; ADR-0003).

## What it owns

Every shape that crosses a process boundary: the console's request and response bodies,
the five client-facing wire dialects, the WebSocket frames, and the stdio protocol to the
automation worker. A shape is declared once, as a Zod schema, and its TypeScript type is
`z.infer` of that schema — never a second declaration that can drift from it.

## The files that matter

- **`src/index.ts`** — the barrel. Everything public goes through it, and the parity test
  reads it to find a factory nobody exported.
- **`src/canonical.ts`** — the pivot: `canonicalMessageSchema`, the content-block union,
  `usageSchema`, `apiErrorSchema`. Every dialect is translated into this shape and back
  out, so the pool, compression and routing layers reason about one representation.
- **`src/common.ts`** — `isoDateTimeSchema`, `idSchema`, `slugSchema`, `pageSchema`,
  `TIME_WINDOWS` and `TIME_WINDOW_MS`. The primitives every other file composes.
- **`src/api/paths.ts`** — `CONSOLE_API_PREFIX`, the `consolePaths` template table, and
  `consolePath()`, which fills `:name` parameters.
- **`src/api/shared.ts`** — `okSchema`, `listQuerySchema`, `bulkResultSchema`, and
  `updateSchema()`, the PATCH-shape factory.
- **`src/entities/`** — one file per domain row: `account.ts`, `job.ts`, `chat.ts`,
  `provider.ts`, `vcc.ts` and the rest, plus the pure catalogue in `cli-tools.ts`.
- **`src/surfaces/`** — one file per wire dialect: chat completions, messages, responses,
  completions, models, with the fields they share in `common.ts`.
- **`src/ws.ts`** — the WebSocket frames, discriminated by `type` and scoped by `channel`
  (ADR-0012).
- **`src/worker-protocol.ts`** — the JSON-lines stdio protocol to the automation worker
  (ADR-0009), validated at both ends (R1.7).
- **`test/parity.test.ts`** — the guard that every exported type is still the inferred
  output of its schema.

## Invariants and traps

- **Zod is the only runtime dependency, and nothing here imports from `apps/`.** Both the
  browser bundle and the server load this package, so a backend-only module reaching the
  web import graph is what the boundary tests exist to catch. No I/O, no state.
- **A type is derived, never declared.** A hand-written `interface` beside a schema is
  exactly what the parity test's compile-time assertions catch; adding one is how the two
  halves start disagreeing about a field.
- **`updateSchema()` exists because `.partial()` does not neutralise `.default()`.** A field
  declared `z.array(z.string()).default([])` still yields `[]` when the key is absent, so a
  PATCH body of `{ name }` would parse to `{ name, entries: [] }` and a rename would silently
  empty a chain. `updateSchema` unwraps each `ZodDefault` first, so absent means leave alone.
- **The two planes share no namespace.** `/v1/*` is the data plane the client SDKs speak and
  `/console/api/*` is the control plane the dashboard reads and writes. Keeping them apart
  lets each be secured, versioned and rate-limited on its own.
- **`consolePath()` throws rather than emit a literal `:id`.** A broken call site fails at
  the boundary instead of requesting a path no handler matches, and the same template
  string doubles as an MSW route pattern.
- **This table is a vocabulary, not a router.** Its order means nothing; what matters is
  the order a _matcher_ tests the templates in. `/tools/vcc/bins` is a sibling of
  `/tools/vcc/:id`, so a matcher that tries the parameterised one first swallows the
  literal. The console's mock handlers register it first for exactly that reason, and
  the same hazard applies to any router built from these strings.
- **The server's JSON columns carry `$type<>()`.** Without it Drizzle types the column as
  `unknown`, and reading a row would need an `as` to use the value — which R1.3 forbids
  outside the parsing boundary.
