# ADR-0004 — Database: SQLite via Drizzle

Status: **Accepted** · Date: 2026-10-11 · Related decisions: D4, D5

## Context

`rutekit` targets self-host — most users will run it on a laptop or in a homelab.
Requiring an external database server would significantly raise setup friction. On the
other hand, the schema is rich enough (20+ tables) that a hand-written query builder
would be fragile.

## Decision

**SQLite** (via `bun:sqlite`) as the default, accessed through **Drizzle ORM**.
PostgreSQL becomes an option added later **without swapping the ORM**.

## Consequences

**Positive**

- Zero-config: no separate DB server; a single file in the data directory.
- `bun:sqlite` built in — no native compilation or WASM fallback needed
  (compared with the 4-tier and 2-tier adapter chains used by other implementations).
- Drizzle provides a typed schema, numbered migrations, and type-safe queries.
- Because Drizzle supports PostgreSQL, the upgrade path is open without a rewrite.

**Negative / risks**

- SQLite writes serially — write throughput is limited. For a personal router's load
  this is not a problem; for multi-user later, PostgreSQL will be needed.
- SQL dialect differences demand discipline: avoid SQLite-specific syntax in `packages/`
  that must later be portable.

## Rejected alternatives

| Alternative                            | Reason for rejection                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------- |
| PostgreSQL from the start              | Needs a separate server (or Docker) — setup friction for self-host; rejected as the default |
| SQLite with a chained fallback adapter | Adds complexity with no real benefit on Bun; `bun:sqlite` is already available              |
| Prisma                                 | Heavy, generate step, separate query engine; explicitly rejected                            |
