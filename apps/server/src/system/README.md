# `system`

Exporting the instance to an archive and restoring it (C13b, SEC-6, ADR-0032).

## What it owns

The one file: a JSON dump of every restorable table, and a restore that replaces them in a
single transaction. Three rules shape the whole module, and each exists because the
alternative is a way to lose data.

## The files that matter

- **`backup.ts`** — `createBackupService`: `manifest`, `export`, `restore`. Also holds
  `toBinding`, which narrows an archive's `unknown` values into what the SQLite driver
  will accept.

## Invariants and traps

- **The authentication state never leaves, whatever the operator asks for.**
  `auth_credential` (the password hash) and `sessions` (live logins) are always omitted,
  and the archive says so in `omitted`. A restore is the configuration of an instance, not
  who may open it — and it means a restore cannot end the session it was made from.
- **Credentials leave only when `includeCredentials` is true, and then as ciphertext.**
  The envelopes are copied _as stored_ (already `SecretBox`-encrypted), so the archive is
  readable only by an instance holding the same `RUTEKIT_ENCRYPTION_KEY`. This is stated
  in the archive rather than left for the reader to work out.
- **A restore replaces in one transaction, and refuses an archive from a newer schema.**
  Replacing is what "restore" means — a merge would produce a mixture of two instances that
  never existed. One transaction makes a failure a no-op. A newer schema is the one
  direction that cannot be recovered from: an older build does not know what a new column
  means.
- **Every identifier is checked against the live schema before any SQL is built.** Table
  names come from `sqlite_master`, column names from `pragma table_info`, and the only
  identifiers that reach a statement are ones that check read back. Values are always
  bound, never spliced. A crafted archive cannot name a table or column rutekit does not
  have.
- **`toBinding` converts booleans to 0/1 and drops anything SQLite cannot store to null**,
  because an archive is a file a person may have edited (`"free_tier": true` is the obvious
  thing for them to write).
- The archive is symmetric on purpose — what comes out is what goes back in — and the
  operator keeps the file, which is the whole point of an export.
