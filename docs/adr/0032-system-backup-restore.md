# ADR-0032 — Backup & restore: an archive the operator owns, credentials opt-in as ciphertext, and a restore that replaces in one transaction

Status: **Accepted** · Date: 2026-10-14 · Related decisions: SEC-6, FR-2.4, FR-12.2, ADR-0018

## Context

C13b is the backend for the **System** part of the console: appearance
(customization), general settings, and backup/restore. The first two already have a
pattern — one JSON record in `app_meta`, read fail-open, written with a merged
PATCH. The third has no counterpart anywhere, and its own contract
(`backupArchiveSchema`, `restoreResultSchema`) answers only the _shape_ of the file,
not the seven questions that determine whether this feature is safe to use:

1. Is the archive written to the server's disk, or returned to the browser?
2. What must **never** be included, even if the operator asks for it?
3. If credentials are included, in what form?
4. Does restore replace or merge?
5. What happens if the archive is from a newer version of rutekit?
6. Table and column names in the archive come from an uploaded file — how does that
   not become SQL injection?
7. Is `app_meta` restored or not?

The answer to number 6 turned out to be less simple than it looks, and one binding
mistake there was found by a test — not by review.

## Decision

**The archive is returned to the browser and never touches the server's disk;
passwords and sessions are never included; credentials are opt-in and come out as
ciphertext; restore replaces in one transaction and rejects a newer archive; every
identifier is validated against the live schema; and `app_meta` is never restored.**

### 1. The archive belongs to the operator, not the server

`POST /backup` answers **with the archive itself**, and the console hands it straight
to a browser download (`useStartBackup` → `downloadText`). Nothing is written to the
data directory.

**The alternative "the server writes a file and reports its path" is rejected**
because it places the most sensitive file an instance can produce right next to its
own database — on the very machine the archive is meant to survive. A backup exists
to outlast the machine; keeping it on that machine inverts its purpose. It also adds
one thing to clean up, one path to protect, and one place where two concurrent
exports could overwrite each other.

The route still sends `content-disposition` alongside the JSON body, so a client that
navigates to that path gets a correctly named download — and so the filename comes
from one place. The console names the file from the same `archive.createdAt`, so the
two cannot differ.

`GET /backup/manifest` remains even though export no longer uses it, and that is
deliberate: the page reads it to show **what a backup will carry** — counts per table
— without having to make one. The manifest reports `includesCredentials: false`
because the default is indeed the safe one; it describes the default backup, not a
possible one.

### 2. Passwords and sessions are never included, whatever the choice

`auth_credential` and `sessions` are in `NEVER_ARCHIVED`, and the archive names both
in `omitted` along with the reason.

An archive carrying a password is a file that can **lock the operator out of their own
instance**: restore an old archive after the password has changed, and the only way
back is to edit SQLite by hand. Carrying live sessions is worse still — it revives a
login the operator has already ended.

The side effect is what makes this operation undoable: **a restore cannot end the
session running it**, because that session is not inside the archive.

`omitted` is part of the format, not decoration. An archive that silently lacks
passwords is a file that **claims to be complete**, and the next person to open it
would have to read the code to know it is not. Naming what was dropped and why lets
the archive explain itself.

### 3. Credentials are included only on request, and come out as ciphertext

`includeCredentials` defaults to `false`. When `true`, the envelope columns are copied
**as-is** — already encrypted by `SecretBox` — so the archive is readable only by an
instance holding the same `RUTEKIT_ENCRYPTION_KEY`. That is stated in the archive,
not left for its reader to discover.

When `false`, the columns **exist but contain `[redacted]`**, rather than being absent.
Two reasons: restore reads the archive back into the same columns, and a missing key
is a column that has to be guessed at; and a marker reads as a marker in a file a
person opens.

The credential columns are named per table — `provider_accounts.credential_envelope`,
`proxies`, `sms_providers`, `vcc_cards.pan_envelope`/`cvv_envelope`, and
`jobs.payload_envelope`. This list is explicit, not the result of column-name
detection, because a column that matches a pattern but is not secret would make the
archive hide ordinary data — and a secret column that does not match a pattern is a
leak nobody would see.

### 4. Restore replaces, in one transaction

A table named by the archive is **emptied then filled**. A table not named is left
alone, and that is reported in `untouched`.

Merging is rejected because the result would be a mixture of two instances that never
existed — with no way back to either. "Restore" means returning to the state of the
archive, not adding the archive's contents to the current state.

One transaction is what makes a mid-way failure a **no-op** rather than a half-written
database. That is the difference between an operation that can be repeated and one
that has to be repaired by hand.

**A table named with an empty list is replaced with empty.** That is a decision, not
an absence of opinion: "this instance has no accounts" is a different statement from
"no opinion about accounts", and a restore that treated the two alike would leave old
rows that should be gone.

### 5. An archive from a newer schema is rejected

`archive.schemaVersion > currentSchemaVersion(sqlite)` → `400`, before anything is
written.

This is the one direction that cannot be recovered. An old build does not know what a
newer column means, and a row written without that column is a row that **lies about
itself**. The opposite direction (an older archive) is supported: a column absent from
the archive is filled with NULL, which is indeed its state.

`format` is separated from `schemaVersion` deliberately: one is the file's shape, the
other the shape of the database inside it. A future change to how archives are written
must not be confused with a migration.

### 6. Every identifier is validated; every value is bound — and those are two different things

Table names come from a file the operator uploaded, and column names from the rows
inside it. Before any SQL is built, the table name is looked up in `sqlite_master` and
the column names in `pragma table_info`. **Only identifiers that pass that check reach
the statement**, and the statement is built from the column list read from the schema —
not from the archive's own keys.

An unknown column → its table is **skipped with a reason**, not partially written. A
row carrying a column this build does not have is either an archive from the future or
a hand-edited file, and the honest answer is to reject it, not to write only the
columns it recognizes.

Values, on the other hand, are always bound and never interpolated. A table name
containing SQL (`providers"; drop table providers; --`) never reaches the statement
because it fails the table check; a value containing SQL
(`Robert"); drop table providers; --`) reaches the statement as a **value**, and
round-trips as-is.

#### 6a. A mistake found by a test: bun:sqlite named binding needs the `$` sigil

The first version built the statement with named parameters
(`insert into t (a, b) values ($a, $b)`) and ran it with the object `{ a: 1, b: 2 }`.
That **does not work**, and the way it fails is the important part.

bun:sqlite matches the binding object against the **parameter tokens in the
statement**, and the tokens include the sigil: `$a`, not `a`. An object keyed by `a`
therefore binds nothing to `$a`.

The consequences branch two ways, and the second is far more dangerous:

- A `NOT NULL` column → `SQLiteError: NOT NULL constraint failed`, which is noisy and
  found immediately.
- A nullable column → **NULL is written, silently.** No error, no warning. A provider
  with `base_url` filled comes back from the archive without its `base_url`, and nobody
  knows until someone presses a button that needs it.

The first version passed 23 of 25 tests, and the tests that failed did so only because
the `NOT NULL` column happened to be first. Binding is now **positional** (`values (?,
?)` with `...names.map(...)`), so no sigil can be wrong. `toBinding` normalizes
`boolean` → `0`/`1` (SQLite has no boolean type, and `"free_tier": true` is the first
thing someone editing an archive by hand writes) and turns non-scalar values into NULL
rather than handing them to the driver.

The regression test exercises **a nullable column that holds a value**, not just a
`NOT NULL` column — because that is the half that fails silently.

### 7. `app_meta` is never restored

`app_meta` holds the boot timestamp and the settings records. A restore that replaced
it would rewrite the settings the restore itself just read — including appearance,
mid-request.

Customization and general settings are therefore restored **through their own path**
(PATCH), not as a side effect of an archive. Backup still includes the table if it is
there, but restore rejects it with a reason.

### 8. One merge rule for both settings records

Customization and general settings use the same rule as every other console PATCH:
**the patch is merged onto the stored record, not onto the defaults**, so a patch naming
one field cannot blank the rest.

`mergePatch` (`runtime/patch.ts`) drops keys that are `undefined`. That is not a type
detail: the console PATCH schema produces `field?: T | undefined`, and under
`exactOptionalPropertyTypes` that shape is **not** `Partial<T>` — one allows a key that
is present-and-undefined, the other does not. Spreading the patch directly would write
`undefined` over a real value, and the record would then fail its own schema on the
next read: a settings page that deletes a field because it did not mention it.

That is also why `AppDeps` gains `meta`: four things already read it, and the System
route is the fifth.

## Consequences

**Positive**

- SEC-6 is filled: export, manifest, restore, with credentials opt-in and passwords
  that are never included.
- Restore cannot lock the operator out of their instance, and cannot end the session
  running it.
- An incomplete archive says so itself through `omitted`.
- A corrupt archive, one from the future, or a hand-edited one ends up as a named
  `skipped` list — not a half-written database.
- The named-binding mistake was found and closed before any real archive went through
  it.

**Negative / risk**

- **No real archive has ever gone through this path.** As with C10, C11, and C12:
  there are no provider accounts in this environment (`RUTEKIT_ENCRYPTION_KEY` is
  empty), so no populated instance has ever been exported and restored. The tests use a
  database filled with synthetic rows.
- **Restore is synchronous and holds one transaction.** An instance with a large
  `requests` table will block for its duration. There is a 64 MiB ceiling on the console
  side, but none on the server side — an archive POSTed straight to the route is not
  size-limited.
- **`includeCredentials` copies ciphertext, not plaintext** — so an archive with
  credentials is useful only to an instance with the same encryption key. That is stated
  in the archive, but it still means "complete backup" does not mean "restorable
  anywhere".
- **The credential columns are named per table and hand-written.** A new table with a
  secret column will not be redacted until someone adds it to `RESTORABLE_TABLES`. No
  test can catch that.
- **`RESTORABLE_TABLES` is hand-written too**, and that is deliberate — but it means a
  table added by a new migration cannot be restored until the list is updated. Restoring
  an archive that names it will report it in `skipped`.
- **There is no validation of row contents.** A hand-edited archive can carry
  `provider_accounts` with `state: 'nonsense'`; the column exists, the value is not
  checked against the enum. What is validated is the identifier and the binding, not the
  value's domain.
- **There is no endpoint to delete or name archives**, because the archive is not on the
  server. That is an accepted consequence of decision 1.

## Rejected Alternatives

| Alternative                                       | Rejected because                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Server writes the archive to the data directory   | The most sensitive file is stored next to its own database, on the machine it is meant to outlive |
| `POST /backup` answers with only the manifest     | The console would have to guess the contents of a file it never saw                               |
| Include passwords so the archive is "complete"    | The archive could lock the operator out of their own instance                                     |
| Include live sessions                             | Revives a login the operator has already ended                                                    |
| Credentials as plaintext                          | One file holding every key, token, and card number                                                |
| Drop credential columns instead of redacting them | A missing key is a column restore has to guess at                                                 |
| Restore merges                                    | Produces a mixture of two instances that never existed                                            |
| Restore without a transaction                     | A mid-way failure leaves a half-written database                                                  |
| Treat an empty list as "no opinion"               | Old rows are left behind while the archive says the table is empty                                |
| Accept an archive from a newer schema             | An old build writes rows without columns it does not understand                                   |
| Discover restorable tables from `sqlite_master`   | Tables added later would be included without anyone deciding                                      |
| Interpolate identifiers after manual escaping     | One escaping bug is one bug in every table                                                        |
| Named-object binding without the `$` sigil        | Binds nothing: NOT NULL fails, nullable silently NULL                                             |
| Restore `app_meta` too                            | Rewrites the settings the restore itself is reading                                               |
| Spread the patch onto the record                  | `undefined` overwrites a real value; the record fails its own schema                              |
| Store settings records as a table                 | Migrations and a repository for one value that is never queried                                   |
