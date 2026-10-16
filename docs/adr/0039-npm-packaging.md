# ADR-0039 — npm packaging: one bundled package

Status: **Accepted** · Date: 2026-10-16 · Related decisions: ADR-0005, ADR-0037

## Context

ADR-0005 decided the CLI is the primary distribution path, and ADR-0037 built it. Neither
said how it would reach npm, and the answer was not obvious: `apps/cli` depends on
`@rutekit/server` through the `workspace:*` protocol, and that package depends on five more
workspace packages the same way. `workspace:*` resolves inside a monorepo and nowhere else,
so publishing the CLI as it stands would produce a package that cannot be installed.

Two shapes were possible, and the difference is what a consumer ends up depending on.

## Decision

**Publish one package, named `rutekit`, whose entry is a bundle.** `bun build` inlines the
CLI, the server and every `@rutekit/*` package into a single `rutekit.js`; the packages that
are already on npm stay external and become the package's real dependencies; and the built
console is shipped beside the bundle as `console/`.

Three details are part of the decision rather than incidental:

1. **`apps/cli/scripts/build-publish.ts` builds it**, and the root `build` script runs it, so
   CI exercises the packaging on every push. An artifact nobody builds is an artifact that
   stops working without anyone noticing.
2. **`promptfoo` is an optional dependency.** It is resolved lazily through `createRequire`
   and never imported at load time, so nothing needs it until a benchmark runs. As a hard
   dependency it would add tens of megabytes to every install for a feature most operators
   never open.
3. **Source maps are excluded.** They are development artifacts, they are the bulk of the
   build — 550 files, and 73 MB against 23 MB without them — and nothing that serves the
   console asks for one.

Two supporting changes were needed to make a bundle work at all. `repoRoot()` now detects
that it is not inside a checkout and answers the working directory, the same answer a
compiled binary gives, so an operator's database lands where they ran the command.
`locateConsole` also looks beside the bundle, which is where a published package's console
is, because there is no checkout to be relative to.

## Consequences

**Positive**

- `bunx rutekit` becomes real: one command, no checkout, no build step.
- One package to version rather than seven, and no lockstep between them.
- The consumer's dependency list is five real packages — `hono`, `drizzle-orm`, `pino`,
  `zod`, `@hono/zod-validator` — instead of the whole internal graph.
- Verified end to end by packing and installing into a clean directory: the installed bin
  reports its version, `init` writes a `.env`, the server boots and applies its migrations,
  and `/` serves the console.

**Negative / risk**

- **The bundle is 0.72 MB and the console 22 MB**, so the package is 23 MB uncompressed and
  5.4 MB packed. The console is the whole of that, and it is the same console the binary
  already embeds — but it is large for an npm package.
- **Automation and benchmark still need a checkout.** The worker's entrypoint and the
  promptfoo provider file are read from a path under the repository root, which a bundle does
  not have. This is not new — a compiled binary has the same gap — but it is now true of the
  npm package too, and it is not fixed here.
- **A bundle is opaque.** A stack trace names `rutekit.js` rather than a source file, and
  source maps are deliberately not shipped, so a bug report from an installed copy is harder
  to read than one from a checkout.
- **Two build targets now produce a runnable server** — the binary and the bundle — and they
  can drift. CI builds both, which is the mitigation rather than a guarantee.

## Rejected Alternatives

| Alternative | Rejected because |
| --- | --- |
| Publish all seven packages | The internal graph becomes public API, and seven packages have to be versioned in lockstep for ever |
| Publish the CLI with `workspace:*` intact | It does not resolve outside the monorepo; the install fails |
| Ship source and require the consumer to build | `bunx rutekit` would not be one command, which was the whole point of ADR-0005 |
| Ship the binary through npm | Works, but a 60 MB+ platform-specific binary per platform is what the standalone build is for, not the registry |
| Include source maps | Multiplies the package size for a debugging aid the browser fetches only when devtools is open |
| Make `promptfoo` a hard dependency | Tens of megabytes on every install for a feature most operators never open |
