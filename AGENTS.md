# AGENTS.md

Working rules in this repository, for AI agents and humans alike. Written from mistakes
that have actually happened — every item in the "Traps" section is something that has
bitten at least once.

Read [RULESET](docs/plan/RULESET.md) first; it is one page and not negotiable. Then
[ARCHITECTURE.md](ARCHITECTURE.md) for the shape of the system.

---

## Commands

```bash
bun run dev              # server (7331) + console (5173)
bun run check            # typecheck + lint + test — run this before claiming you are done
bun run test:coverage    # + coverage gate (NFR-2)
bun run ci               # exactly what CI runs
bun run build            # console + standalone binary
```

`bun run check` is the definition of "done". Green means typecheck, lint, and the whole
suite pass. Do **not** report work as done without running it.

Tests are run with `bun --bun vitest` (through the script), **not** `bunx vitest`: the
server uses `bun:sqlite` and `hono/bun`, and under Node 36 test files fail to load at
all.

---

## Machine-enforced rules

| Rule                                                    | Enforced by                           |
| ------------------------------------------------------- | ------------------------------------- |
| The frontend must not touch `hono`/`drizzle`/`node:*`   | `apps/web/test/boundary.test.ts`      |
| The backend must not touch React                        | `apps/server/test/boundary.test.ts`   |
| Every contract path has a mock handler                  | `apps/web/test/mock-coverage.test.ts` |
| Every console GET answers its contract's shape          | `apps/server/test/contract.test.ts`   |
| No `as`/`any`/`@ts-ignore` outside the parsing boundary | ESLint + `tsconfig` strict            |
| Coverage ≥85% lines on `apps/server/src`                | `bun run test:coverage`               |

**Contracts first (R0.3).** The types and schemas in `packages/contracts` are written
**before** their implementation. A route that precedes its schema is a route whose shape
is decided by the implementation, not the other way around.

---

## Traps

### Version control

**A bare directory in `.gitignore` matches at every depth.** `data/` was written to
exclude the SQLite directory at the root, and it also swallowed `apps/web/src/data/` —
nine source files, the console's data layer, imported by six hooks. They were present on
disk, so `bun run check` passed and `git status` said nothing, and the first push
published a repository that could not build from a clean clone. CI caught it on its first
run and nothing local could have.

Anchor a rule to the root (`/data/`) when it is about one path, and after adding or
changing an ignore rule, check what it actually covers:

```bash
git check-ignore -v <path>          # which rule matched, if any
git status --ignored --porcelain    # what is being excluded
```

An ignored directory collapses to one line in that output, so walk it if you suspect
source is hiding inside.

### Tools and environment

**Tool output in this session corrupts long literals.** A literal written to a file
through a heredoc can read back shorter or altered (e.g. `OpenAI` becoming other text).
For non-ASCII or escape strings (`\n`), write through Python with `chr()` and read it
back to verify — or better, derive the expected value inside the code instead of writing
it as a literal.

**Docker from Git Bash needs `MSYS_NO_PATHCONV=1`.** Without it `/app/data` is converted
into `C:/Program Files/Git/app/data` and the command fails with a message that explains
nothing.

**`docker context` can point at a remote host.** On this development machine the context
can point at a remote host over SSH, and the local daemon may not be running. Check
`docker context show` before blaming the Dockerfile.

### Tests

**Every new guard has to be shot-tested.** Delete the guard and make sure the test
**fails**. This has saved us twice already: the first warmup test passed even with the
guard removed, and the first path-traversal test was testing the URL parser, not the
check. A test that is green without its guard does not test anything.

**`v8` coverage under Bun lies.** It fails to convert most server files and reports every
file it fails to convert as 100%. This project uses `istanbul` (ADR-0034). If you see a
coverage number jump up for no reason, suspect this.

**Vitest does not write a coverage report when any test fails** — so a red suite means
the coverage gate was not evaluated at all. A silent gate is not a gate that passed.

**A `skipIf` guard can hide a gate from CI.** `apps/web/test/bundle-size.test.ts` skips
itself when `apps/web/dist` is missing — reasonable locally, where a build may not have
happened, but it meant CI ran the tests _before_ the build and the only machine check on
the NFR-9 bundle budget silently skipped on every run. The local suite said 1650 passed
while CI said 1645 passed and 5 skipped; that difference is the tell. CI now builds the
console before the tests. When adding a conditional skip, ask what it does on a machine
that has never run the setup step, and compare the skip counts between the two.

**A new migration** requires `apps/server/test/persistence.test.ts` to be updated: the
list of applied ids, `currentSchemaVersion`, the table list, and any new columns.

**A new contract path** requires a handler in `apps/web/src/mocks/handlers/`, or
`mock-coverage.test.ts` fails.

**MSW matches in registration order** — register a `:id` route **last**, or it swallows
literals such as `/tools/vcc/bins`.

**`zod` needs `server.deps.inline: ['zod']`** in the vitest config, or its named exports
go missing and the first `z.object(...)` throws.

### Runtime

**Named `bun:sqlite` parameters need the `$` sigil.** A statement `values ($a, $b)`
executed with the object `{ a, b }` binds nothing: `NOT NULL` columns fail loudly,
**nullable columns are written as NULL silently**. Bind positionally, or include the
sigil. Its regression test exercises a nullable column that holds a value — the half
that fails silently.

**`import.meta.dir` is a bunfs path in a compiled binary** (`B:/~BUN/root`), so counting
levels upward from it yields `\`. `runtime/config.ts` uses `process.cwd()` there,
detected via the `~BUN` marker.

**`import.meta.dir` is `undefined` under the test runner.** Vitest replaces `import.meta`
with an object of its own, so a module-level read of it throws `The "paths[0]" property
must be of type string, got undefined` the moment a test reaches that function — and only
the tests that reach it will say so. The same reason `resolvePromptfooPackage` uses
`createRequire` rather than `import.meta.resolve`. Guard it with `typeof dir === 'string'`
rather than casting, so a runtime without it answers something honest instead of crashing.

**`bun build --compile` embeds nothing by default.** The console has to be added with
`--asset apps/web/dist`, which names the file relative to the asset directory's parent
(`dist/index.html`). Without it the binary serves the API only and its root 404s —
`main.ts` warns at boot when that happens.

**`new URL(...).pathname` already normalizes `..`** before your code sees it. The
containment check in `console.ts` is a second layer that cannot be reached through a
request; test the function directly.

**`crypto.randomBytes` is not a global on Bun** — import it from `node:crypto`.

### Frontend

**A backgrounded tab pauses TanStack retries.** A page that looks stuck on a skeleton in
the Browser pane is often not a page bug: force `focusManager` before concluding an
error branch is broken.

**Do not stop the dev server when you are done.** The user verifies in the browser
afterwards.

---

## Working style

**Language.** Code, comments, type names, and documents are in **English**. Conversation
with the user is in **Indonesian**.

**Comments explain _why_, not _what_.** Files here have long headers that explain the
reasons and the trade-offs — that is the standard, not the exception. But do not repeat
what an identifier name already says, and do not write comments that mention the current
task or PR.

**Do not add abstraction before it is needed.** Three similar lines are better than one
abstraction made before its time. No error handling for scenarios that cannot happen;
validation only at the boundary.

**One group, one checkpoint.** Work is done per group and reviewed before the next group
starts. Do not scroll on to the next group without being asked.

**Report what cannot be verified.** If something has never been run, say so instead of
implying otherwise. This repository has several examples where over-confident claims
were corrected later (ADR-0037), and that is more expensive than admitting the limit up
front.
