# `rutekit` Architecture

This document explains how the pieces fit together and **why**. For the rules that
bind when writing code, read [RULESET](docs/plan/RULESET.md) and
[CONTRIBUTING](docs/plan/CONTRIBUTING.md). For the reasoning behind one particular
decision, [ADR](docs/adr/README.md).

---

## 1. Monorepo

```
apps/
  server/          @rutekit/server  — Hono, Bun.serve, SQLite. Data plane + control plane.
  web/             @rutekit/web     — React 19 + Vite. Console, 27 pages.
  cli/             rutekit          — the `rutekit` command: init + start.
packages/
  contracts/       @rutekit/contracts       — Zod schemas + types. The ONLY FE↔BE bridge.
  translator/      @rutekit/translator      — OpenAI pivot, ingest, render, codec.
  compression/     @rutekit/compression     — five-stage Token Saver pipeline.
  provider-registry/ @rutekit/provider-registry — provider manifests, discovery, auth.
  shared/          @rutekit/shared          — domain-free utilities (id, sse).
tools/
  automation-worker/   its own Node package — Playwright + Camoufox, over stdio (ADR-0009).
  benchmark-provider/  a thin promptfoo provider (.cjs).
  eslint-plugin-rutekit/  the project's own lint rules.
```

**Why `apps/` and `packages/` are separate.** An `app` is a program that is run; a
`package` is a library that is imported. That difference decides what may live inside
each one: `packages/contracts` may have no runtime dependency other than Zod, and may
not import from `apps/*` — because it has to be loadable by the browser and by the
server at the same time.

**Why automation is `tools/` and not `apps/`.** It runs on Node, not Bun, because
Playwright does not exist on Bun. Keeping it as its own workspace makes that boundary
visible and makes its tests run on the runtime that production actually uses.

---

## 2. Boundaries enforced by machine

`apps/web` and `apps/server` are two applications that happen to live in one
repository. The only thing allowed to cross between them is `packages/contracts`.

This is not a convention — two tests walk the real import graph
(`apps/web/test/boundary.test.ts` and `apps/server/test/boundary.test.ts`) and fail on
the first specifier that violates it. Banned in the frontend: `hono`,
`drizzle-orm`, `node:*`, `bun`, `playwright`, and `@rutekit/provider-registry`.

**Why provider-registry is banned too even though it is `packages/`.** A provider
manifest is a server-side statement: it carries endpoints, auth flows, and the shape of
upstream responses. The console is supposed to learn about a provider from the API and
`@contracts`, not from its definition. Closing that door now is what lets the registry
grow fetches and OAuth later without anyone having to notice the day it stops being safe
to bundle.

**Why `packages/contracts` has no logic.** It is types and schemas, not an
implementation. Logic inside it would be logic that has to be correct on two runtimes at
once, and that is twice as hard to test.

---

## 3. Two planes, two audiences

The server serves two namespaces and never mixes them (ADR-0003):

| Namespace        | Audience            | Authentication   | Contents                     |
| ---------------- | ------------------- | ---------------- | ---------------------------- |
| `/v1/*`          | Operator SDK client | API key (Bearer) | The five data-plane surfaces |
| `/console/api/*` | Operator dashboard  | Session cookie   | 85 control-plane paths       |

**Why they are separate.** A `/v1` client must not be able to reach a route that edits
the pool, and the dashboard must not have to understand completion payloads. That
separation is also what lets the two be secured, versioned, and rate-limited
independently.

Two probes (`/healthz`, `/readyz`) sit outside both: they are for a supervisor, not for
the dashboard, and they are the only routes that the readiness gate must not reject.

---

## 4. The flow of one `/v1` request

```
POST /v1/chat/completions
  │
  ├─ ingress:  requestContext → abuseGuard → bodyPolicy
  ├─           readinessGate → apiKeyGuard            (the last two middlewares, per-namespace)
  │
  ├─ ingest:   client body → CanonicalRequest         (packages/translator/ingest)
  ├─ plan:     model name → RankedStep[]              (plan/resolver: mapping → alias → combo → catalog)
  │
  └─ per candidate, until one succeeds:
       ├─ pool.acquire()      → lease + credentials
       ├─ capability          → drop controls this model cannot express
       ├─ Token Saver         → runPipeline()        (packages/compression)
       ├─ phase 2 filter      → block/redact
       ├─ codec.encodeRequest → provider body + path
       ├─ callProvider        → socket
       ├─ codec.decode*       → CanonicalResult / CanonicalStreamEvent
       └─ render              → the client surface's shape
  │
  └─ telemetry.finish()  — one row, written once, when the turn ends
```

Three things in that flow are invariants, not preferences:

**A request always goes through the pivot.** Even when the client and the provider speak
the same dialect. The reason is Token Saver: a body forwarded verbatim is a body that
cannot be compressed. What does **not** always go through the pivot is the _answer_ —
`chooseRoute` returns `direct` for two pairs (Claude→Anthropic,
OpenAI→OpenAI) because re-translating there would throw away something real: the
`signature` of a thinking block must survive byte-for-byte, and an OpenAI client sends
fields the pivot has never heard of (ADR-0019).

**The order of the four steps in `outboundRequest` is the point.** Drop controls that
cannot be expressed → compress → let the phase 2 filter see what compression produced →
address it to the provider's model id. The id is swapped **last** so that every earlier
step sees the name the client knows.

**One telemetry row per turn, written once.** Not updated. A row that is updated is a
row that can be left half-written by a crash, and the only moment every column is known
is when the turn ends.

---

## 5. Composition root

`apps/server/src/app.ts` is a wiring diagram and nothing else: the order of the ingress
stages, the two namespaces, and the socket. Every route added later is one `route()`
line and its own file — nothing here has to know what it does.

Everything a route can reach is assembled in `main.ts` and handed over as **one
object** (`AppDeps` in `types.ts`). That is what lets every test build a real server by
swapping only the socket and the database.

**The middleware order is load-bearing**, and `app.ts` spells it out:

1. `requestContext` — nothing below it can log an id or count an address before it runs.
2. `abuseGuard` — on `*`, not per-namespace, so that a flood of requests to a path that
   does not exist is counted too.
3. `bodyPolicy` — last of the three, because it is the only one that inspects the body
   and may only be reached by a request that has already been identified and counted.
4. `readinessGate` — both namespaces, never the probes.
5. The two doors — a session guard on the control plane, an API-key guard on the data
   plane, both **after** readiness: a server that is draining answers 503 whether or not
   the caller can authenticate.
6. The static console route — registered **last**, because it is a catch-all.

---

## 6. Boot and shutdown

**Boot.** `main.ts` reads configuration (env validated by a Zod schema, and the process
exits with a clear message if it is invalid), opens SQLite, **runs the numbered
migrations**, assembles dependencies, then `Bun.serve`. There is no separate migration
step to remember.

**Shutdown** lives in `runtime/shutdown.ts`, not in `main.ts`, and that is a deliberate
decision (ADR-0036): the D1 warmup bug lived in exactly that ordering and nothing held
it. The order is: reject new work → stop periodic work → stop warmup → kill the workers
→ close the socket → stop the server (with a ceiling) → run hooks.

**The invariant is one: everything that holds a timer or touches the database finishes
before `persistence.close()`.**

---

## 7. Persistence

SQLite via `bun:sqlite`, Drizzle on top of it. Numbered migrations, contiguous from 1,
each applied in its own transaction together with its ledger row — so a failure midway
leaves the database at the last good version, not in between.

**Repositories, not queries in routes.** Every table has one file in `persistence/` that
returns plain methods, so that route handlers never see a query builder and the SQL for
one table lives in one place.

**Aggregation happens at read time, not through a rollup table.** The alternative — a
rollup table written at the end of every turn — makes every read one row and every write
two, and the two can then disagree: a turn whose rollup update failed would be counted
in the request table and missing from the chart, with nothing to reconcile it. Counting
the raw rows means the chart cannot say anything the table does not.

---

## 8. Account pool

`pool/` holds a seven-state state machine (ADR-0020). The rule is: **an account is only
ever blamed for something it can be blamed for.** A turn we addressed wrongly, or that
the client cancelled, says nothing about its credentials — it is ignored, neither
demotion nor recovery.

One deliberate asymmetry: a provider that rejects credentials **during a turn** arrives
as `upstream_error` (the 502 is preserved, because the `/v1` key belongs to the caller,
not to the broken credential), so the turn path can only say "this keeps failing". What
decides `banned` is the **probe**, which sees the raw 401. The two meet — a dead
credential reaches `banned` within one check-in interval — without the data plane having
to lie to its client.

---

## 9. Tests

`bun run check` runs typecheck, lint, and the whole suite. One vitest project per
workspace, because the environments differ: `apps/web` in jsdom (React, MSW),
`apps/server` and `packages/*` in node — and `apps/server` runs **under Bun** because it
uses `bun:sqlite` and `hono/bun`, which do not exist on Node.

What keeps it honest:

| Test                     | Guards                                                    |
| ------------------------ | --------------------------------------------------------- |
| `boundary.test.ts` (two) | The FE/BE boundary, in both directions                    |
| `parity.test.ts` (two)   | Hand-copied lists stay in step with the contracts         |
| `contract.test.ts`       | Every console GET answers the shape its contract promises |
| `matrix.test.ts`         | 4 surfaces × 4 wire families, swept automatically         |
| `mock-coverage.test.ts`  | No page calls a path that is not served                   |
| `isolation.test.ts`      | Every test server has its own database and data dir       |

**Coverage is measured with `istanbul`, not `v8`** (ADR-0034). Under Bun, the v8
provider fails to convert most server files and **reports every file it fails to convert
as 100% covered** — it reported 92.38% for code that is really 86.4%. A gate that
rewards files without tests is worse than no gate at all.

---

## 10. What is not here, deliberately

- **No build step for the backend.** Bun runs TypeScript directly. The only builds are
  the console and the compiled binary.
- **No ORM on the hot path.** Repositories use explicit SQL where aggregation happens;
  Drizzle is used for simple reads and writes.
- **No MITM proxy, Tunnel, Skills/MCP.** Deferred to v2 (the user's decision).
- **No i18n.** English only in v1 (ADR-0013).
- **Automation is not installed in the Docker image.** It needs Node + Playwright +
  Camoufox, hundreds of megabytes for a feature an operator may never use.
