# ADR-0001 — Runtime: Bun

Status: **Accepted** · Date: 2026-10-11 · Related decisions: D1, D2, D4, D9

## Context

Prior art in this space splits across two runtimes: some implementations run on Node.js
(with Bun as an option), others on Bun. `rutekit` requires a single runtime that serves
the HTTP server, test runner, package manager, and build tooling.

## Decision

Use **Bun** as the single runtime for the entire project.

## Consequences

**Positive**

- One runtime for the server, tests (`bun test`, though Vitest is still used for ecosystem), package manager, and bundler.
- `bun:sqlite` built in — no native compilation needed (compared with the fragile `better-sqlite3`).
- Dependency installation is far faster; `bun install` is deterministic via `bun.lock`.
- Compatible with most of the Node ecosystem, so library adoption stays broad.

**Negative / risks**

- Playwright officially supports Node, **not** Bun → resolved by ADR-0009 (Node subprocess).
- Some native packages do not yet have Bun prebuilds; needs case-by-case verification.
- The ecosystem is younger than Node's; some dev tooling still assumes Node.

## Rejected alternatives

| Alternative          | Reason for rejection                                                               |
| -------------------- | ---------------------------------------------------------------------------------- |
| Node.js only         | Needs a separate toolchain (tsx/ts-node, vitest, pnpm); slower; loses `bun:sqlite` |
| Deno                 | npm ecosystem less smooth; Hono runs but the project tooling is less mature        |
| Python + Node hybrid | Two runtimes and a fragile deployment; rejected (R5)                               |
