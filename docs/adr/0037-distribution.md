# ADR-0037 — Distribution: the server serves the console, a binary that can boot, and an in-process CLI

Status: **Accepted** · Date: 2026-10-14 · Related decisions: D5, NFR-9, ADR-0005, ADR-0036

## Context

D3 is the distribution group: the `bunx rutekit` CLI (installer + starter), a standalone
binary, a non-root Docker image, and CI with typecheck/test/coverage/boundary gates.

On inspection, there was one thing on no list at all that blocked all three:

**The server does not serve the console at all.** There is no static route in `app.ts` —
in dev, Vite serves the console and proxies `/console/api`, `/v1`, and `/ws`. That is why
the gap was invisible: every test and every manual check ran behind Vite, so the server
never had to do it. A binary or a container has no Vite in front of it, so both bring up a
server that answers 404 at `/` — an API with no console.

Two other findings surfaced while working:

- **The binary fails to boot.** `repoRoot()` counts four levels up from `import.meta.dir`,
  but `bun build --compile` reports that directory as a path inside a virtual filesystem
  (`B:/~BUN/root`), so the result is `\` and `mkdir('\')` throws `EPERM`.
- **There is no git remote**, so CI has nothing to run against.

## Decision

**The server serves the built console, with an SPA fallback; `repoRoot` answers the
working directory when compiled; the CLI starts the server in-process; and the tray is
dropped.**

### 1. The server serves `dist`, and there is no route when there is no build

`routes/console.ts` registers a catch-all **last**, so every API route above it wins
first. What is left for this module is exactly what nobody else claims: the console's own
files and client-side routes.

**Reserved prefixes are rejected explicitly, not left to ordering.** A request to
`/console/api/nope` matches no route, and without that rejection it would fall through to
the fallback and be answered with `index.html` — a 200 carrying HTML where the console
client expects a JSON error envelope. The client would report "response did not match its
contract" on a path that simply does not exist, which is the least useful version of that
failure.

**Caching is not an optimization here; it is correctness.** The abuse guard counts every
request per address with a ceiling of 600 per minute, and one console page load is in the
range of fifty requests. Without caching, reloading a few times in a minute competes with
the protection that exists precisely to stop an attacker. Vite assets are content-hashed,
so assets under `assets/` are immutable and the browser stores them; `index.html` must
not be, or a deploy would never be picked up.

**Without a build, there is no route.** `dist` does not exist in dev or in any checkout
that has not run `bun run build`, and the honest behavior there is what already exists:
the API answers, and the console is whatever Vite serves. The alternative — failing to
boot because the build artifact is missing — would break `bun run dev` for everyone.

**It is a dependency, not something `buildApp` figures out.** `deps.console` is filled by
`main.ts` from the repo root, and tests decide for themselves. If `buildApp` looked for
it, every test would depend on whether someone had ever run a build on that machine — a
test that passes on one machine and fails on another.

### 2. `repoRoot` answers the working directory when compiled

Run from source, the repo root is four levels up from `apps/server/src/runtime/config.ts`.
Compiled, there is no repository: the bundle lives in a virtual filesystem and
`import.meta.dir` points inside it, so four levels up lands at the filesystem root and
`mkdir` on it throws `EPERM`.

The working directory is the honest answer there: it is where the operator runs the
binary, and `./data/rutekit.sqlite` in a shell must mean the same thing whether it was
started by `bun run dev` or by a compiled `rutekit`.

The detection is the bundle marker in the path (`~BUN`) and not a flag on `Bun`: there is
no `Bun.isStandalone` in the targeted runtime, and that marker is what the runtime itself
uses to name its virtual root.

**This is a bug, not a decision** — it was fixed, not recorded as a limitation.

### 3. The CLI starts the server in-process

`@rutekit/server` exports `main`, and the call at the bottom of that file is guarded by
`import.meta.main`, so importing it to call `main()` does not boot anything on the way in.
The CLI calls it directly.

Spawning would mean a second process to forward signals, and one more path to the server
entrypoint that has to survive being published — with no benefit, because the CLI does
nothing while the server runs.

`--port` and `--host` are applied as environment variables **before** the server reads its
configuration. That is the same door `.env` goes through, so there is one place that
decides what the configuration is instead of two that can disagree.

`rutekit init` writes a `.env` containing two generated secrets, because `.env.example`
asks the operator to run `bun -e` for both and getting them wrong does not produce a crash
— it produces an instance that stores credentials under a key nobody recorded. **And it
refuses to overwrite without `--force`**: `.env` holds the encryption key for every stored
credential, and regenerating it silently would make all of them undecryptable — the data
would still be there and would never be readable again.

### 4. The tray is dropped

The roadmap mentions "installer + starter + tray". A tray is a desktop concern, and rutekit
is a headless server run on a machine that may have no GUI at all. Comparable tools in
this space all ship one; none of them is reason enough.

What is **not** done and not claimed: an installer that downloads a runtime, and
auto-update. `bunx rutekit` assumes Bun is present.

### 5. Automation is not installed in the image

Automation runs Node subprocesses that drive Playwright and Camoufox — browser downloads
measured in hundreds of megabytes, for a feature an operator may never use. The server
comes up without them and reports them as unavailable, just as on a machine that has not
installed Node. An image that wants them adds that layer itself instead of making every
user of this image carry it.

### 6. CI is a thin workflow that calls scripts

Every step in `.github/workflows/ci.yml` is a script from `package.json`, and `bun run ci`
runs the same gates locally. The alternative — writing the commands inside the workflow —
is two lists that have to be kept aligned by hand and that quietly disagree the moment
someone forgets.

**The workflow has never been run**, because there is no git remote on this machine. That
is stated in the file's header rather than left to be assumed green. What **has** been
verified is the scripts: `bun run ci` passes locally.

## Consequences

**Positive**

- The binary, the container, and the CLI finally serve a complete product — a console, not
  just an API. Verified by running a genuinely built binary: `/` and `/settings` → HTML
  200, `/healthz` → JSON 200, `/console/api/nope` → JSON 401.
- The binary failed to boot because of a bug, and the bug was fixed instead of recorded.
- Two CLI bugs were found by its own tests: `parseInt('80.5')` quietly became 80, and the
  `.env` path was built with a hardcoded separator instead of `join`.
- The same gates can be run locally and in CI, from one list.
- Dependency installation inside the image was **verified against a real Linux builder**:
  the `bun install` step failed on `better-sqlite3` (with no prebuilt binary, it compiles
  itself with node-gyp), and once the toolchain was added the step completed — 1242 packages
  in 204 seconds. That is the part most likely to be wrong, and it is proven to work.

**Negative / risk**

- **CI has never been run.** There is no remote, so the workflow is unproven. The scripts
  are not.
- **The Docker image was never finished building, and the container was never run.** Not
  because of the Dockerfile: this machine has no usable Docker daemon. The active context
  points at a remote daemon over SSH (a remote host), and that host became unreachable
  mid-build (`ssh ... exit status 255`); the local Docker Desktop daemon is not running
  either. What was verified is the dependency-install step, not the image. An earlier draft
  of this ADR claimed the image was "genuinely built and run"; that was wrong and is
  corrected here.
- **There is no installer and no auto-update.** `bunx rutekit` assumes Bun is installed.
- **The image has no automation.** That feature needs Node + Playwright + Camoufox, which
  are not installed there.
- **The Docker image uses `debian-slim` + a compiled binary, not `oven/bun`.** That keeps
  the image small and requires no Bun at runtime, but it means a two-stage build cannot be
  avoided and the binary is tied to the build platform — an image for another architecture
  needs a build on that architecture.
- **`Bun.file` is used to serve assets**, so the console route is tied to the Bun runtime.
  That is consistent with the whole server (`bun:sqlite`, `hono/bun`), but it means it is
  not a module that can be moved to Node.
- **The catch-all means every unknown path serves `index.html`.** That is right for an SPA,
  but a request to a mistyped path gets a 200 carrying the application instead of a 404 —
  which is confusing when debugging with `curl`.
- **The healthcheck uses `curl`.** 200 KB for one probe; the alternative is no HTTP client
  at all in `debian-slim`.
- **`--host 0.0.0.0` is the default inside the container.** Right there (the port is only
  reachable through port mapping), but wrong if someone copies that `ENV` outside the
  container.

## Rejected Alternatives

| Alternative                                | Rejected because                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Leave it API-only, console dev-only        | A `bunx rutekit` that cannot show the console is half a product                                                             |
| Embed the build output into the binary     | The biggest change, and a binary that needs a folder beside it is not a standalone binary — postponed, not rejected forever |
| `buildApp` finding `dist` itself           | Every test would depend on whether someone had ever run a build                                                             |
| Fail to boot when `dist` is missing        | Breaks `bun run dev` for everyone                                                                                           |
| Leave reserved prefixes to route ordering  | `/console/api/nope` would be answered with HTML 200 instead of JSON 404                                                     |
| No caching on assets                       | A page load competes with the abuse guard that exists to protect the instance                                               |
| `--target` to cross-compile the binary     | Produces an image that fails with "exec format error" at runtime, not at build time                                         |
| CLI spawns the server as a child process   | A second process to forward signals, with no benefit                                                                        |
| `parseInt` for `--port`                    | `'80.5'` becomes 80 without a word                                                                                          |
| `init` overwrites `.env` by default        | Silently makes every stored credential undecryptable                                                                        |
| Tray as a separate desktop package         | A full desktop app for a headless server                                                                                    |
| Install Playwright + Camoufox in the image | Hundreds of megabytes for a feature that may never be used                                                                  |
| Commands written inside the workflow       | Two lists that have to be kept aligned by hand                                                                              |
| Workflow only, no local scripts            | CI and the developer machine could differ without anyone knowing                                                            |
