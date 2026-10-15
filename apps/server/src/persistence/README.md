# `persistence`

SQLite, Drizzle, the numbered migrations, and one repository per table group (ADR-0004).

## What it owns

The database handle, the schema, the migration runner, and every SQL statement the server
issues. A repository closes over the `Db` and returns plain methods, so a route handler
never sees a query builder and the SQL for one table lives in one file (R5.2). Nothing
here decides anything — the repositories store what a service decided.

## The files that matter

- **`client.ts`** — `openPersistence`: the `bun:sqlite` handle, the pragmas (WAL,
  `foreign_keys`, `busy_timeout`), the Drizzle wrapper, `ping()` and `close()`.
- **`schema.ts`** — every table, in Drizzle. Its per-table comments are the best single
  description of _why_ each column exists; read them before adding one.
- **`migrate.ts`** — `runMigrations` (each migration + its ledger row in one transaction)
  and `currentSchemaVersion`.
- **`migrations/`** — 16 numbered migrations plus `index.ts` (the ordered list) and
  `types.ts`. Most files here are one migration each; group them, do not read them all.
- **The repositories** — `app-meta.ts` is the smallest and the template for the rest;
  `requests.ts` is the largest and holds the read-time aggregations.

## Invariants and traps

- **A released migration is immutable (R5.8).** Never edit a shipped migration or reuse an
  id; a correction is a new migration. The runner asserts ids are **contiguous from 1** and
  refuses to start otherwise.
- **Migrations run at boot, before the socket opens** (A22, NFR-7). There is no separate
  migrate step to remember.
- **`app_meta` is the one-row-store for single-record settings** (Token Saver, pool
  strategy, general settings, appearance). See `META_KEYS`.
- **A repository never holds a `SecretBox`.** Credential envelopes go in encrypted and
  come back encrypted; decrypting is a decision about whether a credential is good, and
  that belongs to the pool/prober, not the store.
- **`setState` is the only writer of `provider_accounts.state`**, and it is the pool's.
  `setCredential` deliberately does not touch state — re-signing-in says nothing about why
  an account left `active`, and a `disabled` account is manual-only.
- **Aggregation happens in SQL, at read time.** There is no rollup table for telemetry: a
  rollup could disagree with the raw rows, and counting the raw rows means a chart cannot
  say anything the table does not.
- **Breakdown dimensions are chosen from a fixed column map** (`BREAKDOWN_COLUMN`), never
  by string interpolation — the dimension arrives from a query string.
- **Never read `provider_accounts.in_flight`.** It is a mirror the pool writes for hand
  inspection; the live count is in memory (ADR-0020).
- **`app_meta`'s write path is the boot smoke test**: the first row written at boot proves
  the whole read/write path works.
