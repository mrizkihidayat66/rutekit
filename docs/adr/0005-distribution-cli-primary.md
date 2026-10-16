# ADR-0005 — Distribution: CLI primary, binary & Docker as alternatives

Status: **Accepted** · Date: 2026-10-11 · Related decisions: D5

## Context

Users need a simple way to run `rutekit`. Three distribution models are common in this
space: a global npm CLI, a standalone binary, and a container image.

## Decision

**CLI (`bunx rutekit`) as the primary distribution path.** A standalone binary
(`bun build --compile`) and a Docker image follow as alternatives.

## Consequences

**Positive**

- `bunx rutekit` is one command, familiar to developers, with no build step.
- Easy updates: bump the CLI version; the dashboard assets are bundled with it.
- No need to ship per-platform artifacts in the first release.
- The dashboard is embedded — no "run the frontend separately" step.

**Negative / risks**

- Users must have Bun installed.
- The npm package is larger because the dashboard assets are bundled in.

## Sequence

| Phase | Artifact                                    |
| ----- | ------------------------------------------- |
| v1    | CLI `bunx rutekit`                          |
| v1.x  | Docker image (non-root, entrypoint, volume) |
| v1.x  | Standalone binary per platform              |

## Status of This Decision

**Decided, and not yet executed.** `apps/cli` carries `"private": true` and has never been
published, so the `bunx rutekit` this ADR names as the primary path resolves against npm
and returns a 404 — reproduced, not inferred. `bun install` links no `rutekit` binary
either, because only dependency bins are linked into `node_modules/.bin`.

The working path today is the one the rejected alternatives dismiss: run it from a
checkout.

```bash
bun apps/cli/src/index.ts init
```

Publishing the `apps/cli` package is what turns this decision into the one-command install
it was written to be. Until then the CLI is a real, tested program that only runs from a
clone, and the README says so.

## Rejected alternatives

| Alternative             | Reason for rejection                                       |
| ----------------------- | ---------------------------------------------------------- |
| Binary only             | Per-platform builds add CI burden; cannot be `bunx`-ed     |
| Docker only             | Requires Docker installed — big friction for desktop users |
| No CLI (clone the repo) | Removes the ease of distribution                           |
