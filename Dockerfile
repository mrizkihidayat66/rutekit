# rutekit in a container (D3).
#
# Two stages, and the split is what keeps the image small: the first needs
# TypeScript, Vite, drizzle-kit and the whole dev dependency tree to produce a
# build; the second needs none of it. What crosses between them is a compiled
# binary and one directory of static files.
#
# **The binary is compiled inside the build stage, on Linux, which is the point.**
# `bun build --compile` produces a binary for the platform it runs on, so building
# it here is what makes it a Linux binary — a `--target` flag would be needed if
# this were cross-compiled, and getting that wrong produces an image that fails
# with "exec format error" at run time rather than at build time.
#
# **The console is copied in beside the binary, not embedded in it.** The server
# locates `apps/web/dist` relative to its working directory when it is running
# standalone (see `repoRoot` in `runtime/config.ts`), so the layout below is not
# arbitrary: `WORKDIR /app` and `apps/web/dist` under it is exactly what a checkout
# looks like, which is why the same code path works in both.
#
# **The automation feature is not installed here.** It runs a Node subprocess
# driving Playwright and Camoufox, which is a browser download measured in
# hundreds of megabytes — for a feature an operator may never use. The server
# starts without it and reports it as unavailable, the same way it does on a
# machine that has not installed Node. An image that wants it should add that
# layer itself rather than making every user of this one carry it.

# ── Build ────────────────────────────────────────────────────────────────────
FROM oven/bun:1.4.2-slim AS build

WORKDIR /src

# A build toolchain, for one transitive native module.
#
# `promptfoo` — the benchmark engine the server depends on — pulls in
# `better-sqlite3`, which has no prebuilt binary for this platform and compiles
# itself with node-gyp on install. The slim base image has neither Python nor a
# compiler, so the install fails with a `gyp ERR!` that says nothing about why.
#
# It is here rather than in the runtime stage on purpose: nothing at run time needs
# a compiler, and the whole point of the two-stage split is that the toolchain does
# not reach the image an operator runs.
RUN apt-get update \
 && apt-get install --no-install-recommends -y python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# The manifests first, so a source-only change does not re-resolve dependencies.
COPY package.json bun.lock bunfig.toml tsconfig.base.json tsconfig.json ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY apps/cli/package.json apps/cli/
COPY packages/compression/package.json packages/compression/
COPY packages/contracts/package.json packages/contracts/
COPY packages/provider-registry/package.json packages/provider-registry/
COPY packages/shared/package.json packages/shared/
COPY packages/translator/package.json packages/translator/
COPY tools/automation-worker/package.json tools/automation-worker/
# `tools/benchmark-provider` is deliberately absent: it is a single `.cjs` file
# with no manifest, so it is not a workspace and there is nothing to resolve.
COPY tools/eslint-plugin-rutekit/package.json tools/eslint-plugin-rutekit/

# `--frozen-lockfile` so an image is built from the dependencies that were
# committed, not from whatever the registry happens to be serving today.
RUN bun install --frozen-lockfile

COPY . .

# The console, then the server. `bun run build` is both, in that order — the
# binary's directory has to exist before the console is copied next to it.
RUN bun run build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime

# `ca-certificates` is not optional: every provider rutekit talks to is HTTPS,
# and without the trust store every call fails with a certificate error that
# looks like the provider being down.
# `curl` is for the healthcheck below — `debian-slim` ships no HTTP client, and
# the alternatives (a `wget` that is not there either, or a raw TCP check that
# cannot see a 503) are worse than the 200 KB.
RUN apt-get update \
 && apt-get install --no-install-recommends -y ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

# A dedicated user, and the data directory owned by it. Running as root would
# mean anything written — the SQLite file, generated assets, an automation
# screenshot — is owned by root on the host's bind mount, which is a thing an
# operator discovers when they try to back it up.
RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin rutekit \
 && mkdir -p /app/data \
 && chown -R rutekit:rutekit /app

WORKDIR /app

COPY --from=build --chown=rutekit:rutekit /src/dist/rutekit /app/rutekit
COPY --from=build --chown=rutekit:rutekit /src/apps/web/dist /app/apps/web/dist

USER rutekit

# Where the database and generated assets live. A volume so an operator can
# replace the container without replacing the instance.
ENV RUTEKIT_DATA_DIR=/app/data \
    RUTEKIT_DATABASE_URL=/app/data/rutekit.sqlite \
    RUTEKIT_HOST=0.0.0.0 \
    RUTEKIT_PORT=7331

# Bound to all interfaces above *because* it is inside a container: the port is
# only reachable through the published mapping, and a container that listened on
# loopback would be unreachable from outside it. `docker run -p 127.0.0.1:7331:7331`
# is what keeps it off the network.
EXPOSE 7331

VOLUME ["/app/data"]

# `tini` as PID 1. The server handles SIGTERM itself and drains, but it needs the
# signal to arrive — without an init, a shell-wrapped process can swallow it and
# the container gets SIGKILLed after the timeout instead of shutting down cleanly.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/rutekit"]

# `/healthz`, not `/readyz`, and the difference matters here. `/readyz` turns 503
# the moment a drain begins — which is exactly when a supervisor should stop
# routing to the container, and also exactly when a healthcheck that restarts on
# failure would kill the requests the drain was politely finishing. Liveness is
# the question a container healthcheck is asking: is this process still working?
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["curl", "--fail", "--silent", "--show-error", "http://127.0.0.1:7331/healthz"]
