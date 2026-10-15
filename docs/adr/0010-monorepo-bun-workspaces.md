# ADR-0010 — Monorepo: Bun workspaces

Status: **Accepted** · Date: 2026-10-11 · Related decisions: D10

## Context

`rutekit` requires a strict separation between frontend, backend, and shared packages
(contracts, translator, compression, registry). This requires a workspace so that
`packages/contracts` can be imported by both sides without npm publication.

## Decision

**Bun workspaces** — the `workspaces` configuration in the root `package.json`.

```json
{ "workspaces": ["apps/*", "packages/*", "tools/*"] }
```

## Consequences

**Positive**

- Zero-config: already built into Bun (ADR-0001).
- No extra tool to install, configure, and maintain.
- `bun install` from the root installs the whole workspace with one lockfile.
- Cross-package imports work directly via package name (`@rutekit/contracts`).
- Sufficient for 7 packages (2 apps + 5 packages) — matching the project's scale.

**Negative / risks**

- No built-in task orchestration (e.g. run tests only on affected packages).
- No cross-package build caching.

## Mitigation

Because the scale is small, orchestration via root `package.json` scripts (`bun run test`
runs the whole workspace) is sufficient. If CI time becomes a problem, upgrade to
Turborepo without changing the workspace structure.

## Rejected alternatives

| Alternative    | Reason for rejection                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------ |
| Turborepo      | Task graph and caching are useful, but the configuration overhead is not worth it for 7 packages |
| Nx             | Very powerful, but heavily overkill; steep learning curve                                        |
| Separate repos | An extra runtime must fetch from the registry; loses atomic cross-package changes                |
