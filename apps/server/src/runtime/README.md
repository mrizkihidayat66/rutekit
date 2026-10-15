# `runtime`

Process lifecycle, environment configuration, and the single-record settings stores.

## What it owns

Bringing the process up and taking it down in a fixed order, validating the environment
once at boot, and the four `app_meta`-backed settings records (Token Saver, general
settings, appearance, pool strategy is in `pool/`). It is the folder a change touches when
it changes _how the process runs_ rather than what it does.

## The files that matter

- **`config.ts`** — the Zod `envSchema`, `parseConfig`, `loadConfig`, `repoRoot`,
  `isCompiledBinary`. Every variable in `.env.example` is declared here with the same
  default.
- **`lifecycle.ts`** — `Lifecycle`: the `starting/ready/draining/stopped` state,
  `acceptingRequests`, and the shutdown-hook registry.
- **`shutdown.ts`** — `createShutdown`: the pinned teardown order. Its header is the
  authority on _why_ each step is where it is.
- **`patch.ts`** — `PatchOf<T>` and `mergePatch`: the shared patch semantics for the
  settings stores.
- **`general-settings.ts`**, **`token-saver.ts`**, **`customization.ts`** — the three
  settings stores, all the same shape: one JSON row in `app_meta`, read fail-open, write by
  merge.

## Invariants and traps

- **A misconfiguration is a startup failure with a readable list**, not an `undefined`
  three layers deep. `ConfigError` carries every problem at once.
- **Relative `RUTEKIT_*` paths resolve against the repo root, not the cwd** — except in a
  compiled binary, where `repoRoot()` answers `process.cwd()` because there is no repo.
  See the long note in `config.ts`.
- **The shutdown order in `shutdown.ts` is the subject of the file, not incidental.**
  Everything that holds a timer or reaches for the database must finish before
  `persistence.close()`. A D1 bug (`RangeError: Cannot use a closed database` from an
  un-watched timer) is why it is extracted and pinned by `apps/server/test/shutdown.test.ts`.
- **`Lifecycle.runShutdownHooks` runs hooks last-registered-first** — the reverse of how
  the registration lines read. The header says so explicitly because the next hook added
  may not be indifferent to the order.
- **`exit` is injected.** `process.exit(0)` is right in production and catastrophic in a
  test, so the one thing that must not be hard-coded is the one thing that leaves the
  process.
- **Every settings store reads fail-open.** A row hand-edited into something the contract
  no longer describes falls back to the defaults — a broken settings row must never be the
  reason a turn fails.
- **Writes are merges, not replacements.** A patch that names one field must not reset the
  rest; `mergePatch` drops explicit `undefined` keys for exactly this reason (see
  `patch.ts` for why `Partial<T>` is not the right type here).
- **`lowStressMode` is read on the hot path** (the planner reads it per turn), so it must
  not be captured at boot.
