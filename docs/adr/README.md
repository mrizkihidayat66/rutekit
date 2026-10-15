# Architecture Decision Records — `rutekit`

Every significant architecture decision is recorded here. Format: Context → Decision →
Consequences → Rejected alternatives.

An ADR is never deleted. If a decision changes, a new ADR is written and the old one is
marked **Superseded by ADR-NNNN**.

## Index

| #    | ADR                                                                                    | Decision                                                                                                                                                | Status   |
| ---- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 0001 | [Runtime: Bun](0001-runtime-bun.md)                                                    | Bun as the single runtime                                                                                                                               | Accepted |
| 0002 | [Language: TypeScript](0002-typescript-end-to-end.md)                                  | TypeScript end-to-end, fully strict                                                                                                                     | Accepted |
| 0003 | [Backend: Hono](0003-backend-hono.md)                                                  | Hono as the backend framework                                                                                                                           | Accepted |
| 0004 | [Database: SQLite + Drizzle](0004-database-sqlite-drizzle.md)                          | SQLite via Drizzle, PostgreSQL later                                                                                                                    | Accepted |
| 0005 | [Distribution: CLI first](0005-distribution-cli-primary.md)                            | `bunx rutekit`; binary & Docker as alternatives                                                                                                         | Accepted |
| 0006 | [Provider scope v1](0006-v1-provider-scope.md)                                         | ~30 curated providers                                                                                                                                   | Accepted |
| 0007 | [Styling: Tailwind + tokens](0007-styling-tailwind-tokens.md)                          | Tailwind as the substrate, tokens as the truth                                                                                                          | Accepted |
| 0008 | [Auth: single-user](0008-auth-single-user.md)                                          | Password → session cookie, Argon2id                                                                                                                     | Accepted |
| 0009 | [Automation: Node subprocess](0009-automation-node-subprocess.md)                      | Node + Playwright over stdio                                                                                                                            | Accepted |
| 0010 | [Monorepo: Bun workspaces](0010-monorepo-bun-workspaces.md)                            | Bun workspaces with no extra tooling                                                                                                                    | Accepted |
| 0011 | [UI: Radix + custom](0011-ui-radix-custom.md)                                          | Radix primitives, styled in-house                                                                                                                       | Accepted |
| 0012 | [Real-time: WebSocket](0012-realtime-websocket.md)                                     | One WS for all dashboard telemetry                                                                                                                      | Accepted |
| 0013 | [Language & naming](0013-language-and-naming.md)                                       | English only; generic tokens with no codenames                                                                                                          | Accepted |
| 0014 | [Chat: tiered picker](0014-chat-page-picker.md)                                        | Provider → Model → Thinking                                                                                                                             | Accepted |
| 0015 | [Studio: prompt-first](0015-studio-prompt-first.md)                                    | Prompt-first + gallery, not a canvas                                                                                                                    | Accepted |
| 0016 | [Dot trick: standalone](0016-dot-trick-scope.md)                                       | A utility on the Tools page                                                                                                                             | Accepted |
| 0017 | [Feature dependency adoption](0017-feature-dependency-adoption.md)                     | AI SDK, streamdown, assistant-ui, promptfoo, JSD                                                                                                        | Accepted |
| 0018 | [Provider manifest = source of truth](0018-provider-manifest-source-of-truth.md)       | One declarative, inert manifest per provider                                                                                                            | Accepted |
| 0019 | [Pivot OpenAI + direct route](0019-translator-pivot-direct-route.md)                   | The canonical shape as pivot; `direct` for two fragile pairs                                                                                            | Accepted |
| 0020 | [Account pool: state machine & lease](0020-account-pool-state-machine.md)              | 7 states, manual vs automatic transitions, lease, in-flight in memory, unified check-in                                                                 | Accepted |
| 0021 | [Plan: resolution order & fallback bounds](0021-plan-resolution.md)                    | mapping → alias → combo → catalog; fallback until a 200 commits; no plan cache                                                                          | Accepted |
| 0022 | [Capability-aware routing](0022-capability-aware-routing.md)                           | Reorder then degrade; `x-rutekit-degraded` header; embeddings refused                                                                                   | Accepted |
| 0023 | [Telemetry: tables, aggregation, ring log](0023-telemetry-and-usage.md)                | One retained `requests` table; aggregation at read time; ring log; genuinely low-stress                                                                 | Accepted |
| 0024 | [Automation credential pools](0024-automation-credential-pools.md)                     | Proxy + SMS: write-only credentials, measured health, row-by-row import                                                                                 | Accepted |
| 0025 | [Automation worker lifecycle](0025-automation-worker-lifecycle.md)                     | One worker per job; pause kills; the deadline belongs to the host; retry in the worker                                                                  | Accepted |
| 0026 | [Browser driver: flows, captcha, stall](0026-browser-driver-flows.md)                  | Flow registry; captcha from text; stall unless parked; machine ceiling                                                                                  | Accepted |
| 0027 | [Tooling: VCC, filters, dot trick](0027-tooling.md)                                    | The PAN is readable via reveal; filters scan the conversation; `block` = a named 400                                                                    | Accepted |
| 0028 | [Chat: two front doors, one call core](0028-chat-backend.md)                           | `model-call.ts` used by both `/v1` and the console; renderers as the seam; a busy pool = an error                                                       | Accepted |
| 0029 | [Studio: one driver, in-process jobs, safe files](0029-studio-backend.md)              | Real ComfyUI + seam; the deadline belongs to the queue; paths from its own id; lineage recorded                                                         | Accepted |
| 0030 | [Benchmark: promptfoo, per-run keys, the meaning of "fail"](0030-benchmark-backend.md) | promptfoo as a child process; scoped keys revoked in `finally`; the rubric in the contract; a failed cell = a failed call                               | Accepted |
| 0031 | [Model verification: direct probe, measured posterior](0031-model-verification.md)     | The probe goes through `callModel`, not `/v1`; empty baseline + calibration; only a measured signal opens a verdict                                     | Accepted |
| 0032 | [Backup & restore: the archive belongs to the operator](0032-system-backup-restore.md) | The archive goes to the browser, not to disk; passwords/sessions never travel; restore replaces in one transaction; identifiers validated, values bound | Accepted |
| 0033 | [CLI config generator](0033-cli-tools-config-generator.md)                             | Text to copy, not a file; the base URL belongs to the operator; `/v1` per client; the catalog becomes data with no route                                | Accepted |
| 0034 | [Test hardening](0034-test-hardening.md)                                               | istanbul provider (v8 under Bun reports failed-to-convert files as 100%); matrix sweep; parity from both sides; a contract test found C14               | Accepted |
| 0035 | [Token Saver savings](0035-token-saver-savings.md)                                     | One JSON column on `requests`; measured around the pipeline only; NULL = did not run, not zero; only `/v1` turns count                                  | Accepted |
| 0036 | [Operational hardening](0036-operational-hardening.md)                                 | Shutdown order extracted + pinned; forward migration tested with data; archive tested through a file; a replacing restore = no duplicates               | Accepted |
| 0037 | [Distribution](0037-distribution.md)                                                   | The server serves the console + SPA fallback; `repoRoot` answers cwd when compiled; CLI in-process; tray dropped; CI green on a clean checkout          | Accepted |
| 0038 | [Polish: contrast measured, borders recorded](0038-polish-a11y-and-performance.md)     | Contrast from tokens (axe is blind in jsdom); `--color-warning` fixed, control borders recorded as a gap; bundle 193/300KB; LCP cannot be measured here | Accepted |

## Decision → Document Map

| Decision                  | Appears in                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| D1 Runtime                | [ADR-0001](0001-runtime-bun.md), [PRD §2](../plan/PRD.md), [ROADMAP D3](../plan/ROADMAP.md)                            |
| D2 Language               | [ADR-0002](0002-typescript-end-to-end.md), [CONTRIBUTING §4](../plan/CONTRIBUTING.md)                                  |
| D3 Backend                | [ADR-0003](0003-backend-hono.md), [PRD §3.4](../plan/PRD.md)                                                           |
| D4 Database               | [ADR-0004](0004-database-sqlite-drizzle.md), [CONTRIBUTING §5.4](../plan/CONTRIBUTING.md)                              |
| D5 Distribution           | [ADR-0005](0005-distribution-cli-primary.md), [ROADMAP D3](../plan/ROADMAP.md)                                         |
| D6 Provider               | [ADR-0018](0018-provider-manifest-source-of-truth.md), [ROADMAP C3](../plan/ROADMAP.md)                                |
| D7 Styling                | [ADR-0007](0007-styling-tailwind-tokens.md), [PRD §7](../plan/PRD.md), [RULESET R3](../plan/RULESET.md)                |
| D8 Auth                   | [ADR-0008](0008-auth-single-user.md), [PRD §9](../plan/PRD.md), [ROADMAP C2](../plan/ROADMAP.md)                       |
| D9 Automation             | [ADR-0009](0009-automation-node-subprocess.md), [PRD §6.5](../plan/PRD.md), [ROADMAP C7](../plan/ROADMAP.md)           |
| D10 Monorepo              | [ADR-0010](0010-monorepo-bun-workspaces.md), [PRD §3.1](../plan/PRD.md)                                                |
| D11 UI                    | [ADR-0011](0011-ui-radix-custom.md), [CONTRIBUTING §6.1](../plan/CONTRIBUTING.md)                                      |
| D12 Real-time             | [ADR-0012](0012-realtime-websocket.md), [ROADMAP C1](../plan/ROADMAP.md)                                               |
| D13 UI language           | [ADR-0013](0013-language-and-naming.md), [CONTRIBUTING §12](../plan/CONTRIBUTING.md)                                   |
| D14 Naming                | [ADR-0013](0013-language-and-naming.md), [PRD §7.1](../plan/PRD.md)                                                    |
| D15 Chat                  | [ADR-0014](0014-chat-page-picker.md), [PRD FR-7.1](../plan/PRD.md), [ADR-0028](0028-chat-backend.md)                   |
| D16 Studio                | [ADR-0015](0015-studio-prompt-first.md), [PRD FR-8.1](../plan/PRD.md), [ADR-0029](0029-studio-backend.md)              |
| D17 Dot trick             | [ADR-0016](0016-dot-trick-scope.md), [PRD FR-11.1](../plan/PRD.md)                                                     |
| D18 Benchmark             | [PRD FR-9.1](../plan/PRD.md), [ADR-0017](0017-feature-dependency-adoption.md), [ADR-0030](0030-benchmark-backend.md)   |
| D19 Model verification    | [PRD FR-10.1](../plan/PRD.md), [ADR-0017](0017-feature-dependency-adoption.md), [ADR-0031](0031-model-verification.md) |
| D20 Backup & restore      | [PRD SEC-6](../plan/PRD.md), [ADR-0032](0032-system-backup-restore.md)                                                 |
| D21 CLI tools             | [PRD FR-2.4](../plan/PRD.md), [ADR-0033](0033-cli-tools-config-generator.md)                                           |
| D22 Test hardening        | [PRD NFR-2](../plan/PRD.md), [ADR-0034](0034-test-hardening.md)                                                        |
| D23 Token Saver savings   | [PRD FR-1.2](../plan/PRD.md), [ADR-0035](0035-token-saver-savings.md)                                                  |
| D24 Operational hardening | [PRD NFR-7, NFR-8](../plan/PRD.md), [ADR-0036](0036-operational-hardening.md)                                          |
| D25 Distribution          | [PRD D5](../plan/PRD.md), [ADR-0005](0005-distribution-cli-primary.md), [ADR-0037](0037-distribution.md)               |
| D26 Polish                | [PRD NFR-4, NFR-6, NFR-9](../plan/PRD.md), [ADR-0038](0038-polish-a11y-and-performance.md)                             |

## How To Write A New ADR

1. Copy the next number: `NNNN-short-title.md`.
2. Fill in the four sections: **Context** (why a decision is needed), **Decision** (what was
   decided, firmly), **Consequences** (positive and negative, honestly), **Rejected
   alternatives** (a table with reasons).
3. Add a row to the index above.
4. If you are changing an older decision, mark the old ADR `Superseded by ADR-NNNN`.

**When an ADR is required:** changing an architectural boundary, adding a dependency that
affects the architecture, changing a pipeline order, changing a state-machine schema, adding a
new process, or changing a public contract.

**When it is not:** internal refactoring, bug fixes, adding a page, styling changes.
