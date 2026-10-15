# Contributing

Read [docs/plan/RULESET.md](docs/plan/RULESET.md) first — one page of rules that are not
negotiable. The reasoning behind them is in
[docs/plan/CONTRIBUTING.md](docs/plan/CONTRIBUTING.md), and the practical working rules and
known traps are in [AGENTS.md](AGENTS.md).

## Before opening a pull request

```bash
bun install
bun run check
```

`bun run check` is the definition of done: typecheck, lint, and the whole test suite. A
change that does not pass it is not ready.

## The two rules that catch most people

**Contracts come first.** Types and Zod schemas live in `packages/contracts` and are written
before their implementation. A route that precedes its schema is a route whose shape was
decided by the implementation rather than the other way around.

**The frontend and the backend do not share an import graph.** A test walks it and fails if
`apps/web` touches Hono, Drizzle, `node:*` or Playwright, or if `apps/server` touches React.
`packages/contracts` is the only bridge. When something needs to cross that line, it belongs
in contracts.

## Adding a provider

One file under `packages/provider-registry/src/providers/`, then regenerate the index:

```bash
bun run --filter @rutekit/provider-registry generate
```

A staleness test fails if the index and the provider files disagree.

## Changing the database

Migrations are numbered and immutable — a released one is never edited. Add the next number
under `apps/server/src/persistence/migrations/`, and update
`apps/server/test/persistence.test.ts`, which asserts the applied ids, the current schema
version, the table list and the columns. That test is what stops a migration from being
half-applied.

## Adding a contract path

A new path in `consolePaths` needs a handler in `apps/web/src/mocks/handlers/`, or
`mock-coverage.test.ts` fails.
