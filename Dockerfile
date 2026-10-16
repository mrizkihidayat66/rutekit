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
# **The automation feature is installed, with Chromium and without Camoufox.** It
# runs a Node subprocess driving a real browser, so the image carries a Node
# binary beside the Bun-compiled server and a Chromium build for it to drive —
# the layer costs about 400 MB. Camoufox is the one engine left out: it is a
# separate hardened Firefox build fetched on top of its own dependency tree, the
# curated providers' flows all run on Chromium, and the server reports the engine
# as unavailable rather than failing a job that asks for it. An operator who needs
# it should add that layer rather than make every user of this image carry it.
#
# The worker's dependency closure is three packages — see the runtime stage for
# why it is copied out of the build store rather than installed again.

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

# The worker's runtime closure, assembled here so the runtime stage can take it in
# one copy.
#
# **This exists because `COPY` flattens.** A store entry is named with its
# resolved version (`playwright@1.64.0`) and the runtime has to keep that name —
# the symlinks inside the tree point at it — but `COPY <dir> /dest/` copies a
# directory's *contents* into `/dest`, so the name is lost and the next entry
# lands inside the previous one. `cp -a` under a shell glob keeps both the name
# and the symlinks, which is what this step buys.
#
# Only what the worker imports: `playwright` (with `playwright-core`), and
# `@rutekit/contracts` with the `zod` it needs. Camoufox is deliberately absent —
# see the image header.
RUN set -eux; \
    mkdir -p /automation/node_modules/.bun \
             /automation/tools/automation-worker/node_modules/@rutekit \
             /automation/packages/contracts/node_modules; \
    cp -a node_modules/.bun/playwright@* node_modules/.bun/playwright-core@* node_modules/.bun/zod@* /automation/node_modules/.bun/; \
    cp -a tools/automation-worker/src /automation/tools/automation-worker/src; \
    cp -a tools/automation-worker/package.json /automation/tools/automation-worker/; \
    cp -a tools/automation-worker/node_modules/playwright /automation/tools/automation-worker/node_modules/; \
    cp -a tools/automation-worker/node_modules/@rutekit/contracts /automation/tools/automation-worker/node_modules/@rutekit/; \
    cp -a packages/contracts/src /automation/packages/contracts/src; \
    cp -a packages/contracts/package.json /automation/packages/contracts/; \
    cp -a packages/contracts/node_modules/zod /automation/packages/contracts/node_modules/

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime

# `ca-certificates` is not optional: every provider rutekit talks to is HTTPS,
# and without the trust store every call fails with a certificate error that
# looks like the provider being down.
# `curl` is for the healthcheck below — `debian-slim` ships no HTTP client, and
# the alternatives (a `wget` that is not there either, or a raw TCP check that
# cannot see a 503) are worse than the 200 KB.
# `libatomic1` is for the Node binary copied in below: Node is linked against it,
# `slim` does not ship it, and the failure is `node: error while loading shared
# libraries: libatomic.so.1` with exit code 127 — which reads as "node is not
# installed" rather than as a missing library.
RUN apt-get update \
 && apt-get install --no-install-recommends -y ca-certificates curl tini libatomic1 \
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

# ── Automation (browser-driven provider sign-in) ─────────────────────────────
#
# The worker is a **Node** process — Playwright supports Node, not Bun, and a
# browser crash must not take the gateway with it (ADR-0009) — so the runtime
# needs a Node binary beside the Bun-compiled server. Taken from the official
# image rather than installed from the distribution, which freezes whatever Node
# its release shipped and is not a thing to leave to chance under a browser
# driver. Node strips TypeScript types on its own from 22.18 on, which is what
# lets the worker's `.ts` entrypoint run with no build step.
COPY --from=node:26-bookworm-slim /usr/local /usr/local

# The worker's dependency closure, and nothing else — assembled in the build stage
# (see the `cp -a` step there for why it cannot be a selective `COPY`).
#
# **The relative shape is what makes it work.** bun writes these links as
# `../../../node_modules/.bun/…`, so they resolve only if the tree keeps its shape
# — which is why the layout reproduces a checkout (`tools/`, `packages/`,
# `node_modules/`) instead of flattening the packages somewhere tidier. Copied as
# a whole, the links come with it and nothing has to be rebuilt by hand.
COPY --from=build /automation/ /app/

# Chromium, and the system libraries it needs. `--with-deps` runs the apt install
# itself, which is why this happens before the user switch — and the browser goes
# to a path the image owns rather than the default under `$HOME`, so it is part of
# the image instead of something each container downloads on first use.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN node /app/tools/automation-worker/node_modules/playwright/cli.js install --with-deps chromium \
 && chown -R rutekit:rutekit /opt/pw-browsers

# What a **headed** browser needs, which a container does not have by default.
#
# Headed Chromium refuses to start without a display, and under a read-only rootfs
# it refuses again without a writable `HOME` — its crash handler and profile need
# somewhere to write, and `/home/rutekit` is part of the read-only image. Both
# failures reach the job as the same sentence, `Target page, context or browser
# has been closed`, which is why this is spelled out rather than left to be
# rediscovered: headless works fine without either, so the difference only shows
# up when somebody picks the other mode.
#
# `xvfb` is already in the image — `playwright install --with-deps` brings it —
# so this is a start, not an install. `HOME` is safe to point at `/tmp`: nothing
# in the server or the worker reads it, and the tmpfs is writable and per-container.
#
# The socket directory has to be created at run time because `/tmp` is a tmpfs
# mounted over whatever the image had there.
RUN printf '%s\n' \
      '#!/bin/sh' \
      '# Start a display for headed Chromium, then hand over to the server.' \
      'set -e' \
      'mkdir -p /tmp/.X11-unix' \
      'Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &' \
      'export DISPLAY=:99' \
      'export HOME=/tmp' \
      'exec /usr/bin/tini -- /app/rutekit' \
    > /usr/local/bin/rutekit-entrypoint.sh \
 && chmod 0755 /usr/local/bin/rutekit-entrypoint.sh

USER rutekit

# Where the database and generated assets live. A volume so an operator can
# replace the container without replacing the instance.
#
# `RUTEKIT_NODE_BINARY` is what the server spawns the worker with. It is the
# default value, named here because this image is the one that guarantees the
# binary exists.
ENV RUTEKIT_DATA_DIR=/app/data \
    RUTEKIT_DATABASE_URL=/app/data/rutekit.sqlite \
    RUTEKIT_HOST=0.0.0.0 \
    RUTEKIT_PORT=7331 \
    RUTEKIT_NODE_BINARY=node

# Bound to all interfaces above *because* it is inside a container: the port is
# only reachable through the published mapping, and a container that listened on
# loopback would be unreachable from outside it. `docker run -p 127.0.0.1:7331:7331`
# is what keeps it off the network.
EXPOSE 7331

VOLUME ["/app/data"]

# The entrypoint starts the display and then `exec`s `tini`, so `tini` is still
# what reaps and forwards signals — the server handles SIGTERM itself and drains,
# but it needs the signal to arrive, and a shell that stayed as PID 1 could
# swallow it and get the container SIGKILLed instead of shutting down cleanly.
ENTRYPOINT ["/usr/local/bin/rutekit-entrypoint.sh"]

# `/healthz`, not `/readyz`, and the difference matters here. `/readyz` turns 503
# the moment a drain begins — which is exactly when a supervisor should stop
# routing to the container, and also exactly when a healthcheck that restarts on
# failure would kill the requests the drain was politely finishing. Liveness is
# the question a container healthcheck is asking: is this process still working?
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["curl", "--fail", "--silent", "--show-error", "http://127.0.0.1:7331/healthz"]
