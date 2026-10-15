# ADR-0036 — Operations: a pinned shutdown order, forward migration with data, and archives through files

Status: **Accepted** · Date: 2026-10-14 · Related decisions: NFR-7, NFR-8, ADR-0032, ADR-0034

## Context

D2 is the second group of PHASE D, and the roadmap asks for four things: self-migration
verified on an empty DB **and an old DB**, graceful shutdown (drain + `503
shutting_down`), backup/restore end to end, and telemetry export/import without
duplication.

On inspection, the four are not equally heavy:

| Item                       | State before D2                                           |
| -------------------------- | --------------------------------------------------------- |
| Self-migration, empty DB   | Covered — `memory()` + the shipped migration list         |
| Self-migration, **old DB** | **No test migrates forward from an old schema with data** |
| Drain + `503`              | Covered — `lifecycle` + `server-app` "during a drain"     |
| Shutdown **order**         | Cannot be tested: a block inside a non-exported `main()`  |
| Backup/restore end to end  | 25 tests over HTTP, all in memory                         |
| Telemetry export/import    | The design meets the need; not yet verified               |

So D2 is mostly **verification**, with one real gap and one thing that needs a decision.

## Decision

**The shutdown order is extracted into a testable function; forward migration is tested
with data in it; and archives are tested through real files.**

### 1. The shutdown order is extracted, because a bug lives there

In D1 we found `RangeError: Cannot use a closed database`: a warmup sweep still running
read the database after `persistence.close()` had run beneath it. The source was the
**order**, and the order was already correct at the time — what was missing was anything
that **held it**. That block lived inside `main()`, a 470-line function that is not
exported and cannot be reached by any test, so an edit that looked reasonable could break
it again and the only symptom would be an unhandled rejection with no listener.

`runtime/shutdown.ts` moves the order into a function that takes its dependencies, and
`main.ts` now only awaits it. What is pinned is not "these functions are called" but the
**order**, because the order is the subject:

1. `beginDrain()` — refuse new work first, so the window between "stopping" and "fully
   stopped" can be read.
2. Every interval, then log subscriptions. No periodic work may run while the things it
   reaches are being torn down.
3. `warmup.stop()` — the only periodic worker holding a **network** round trip and reading
   the database on both sides of it, so the only one that can still be mid-probe here.
4. `jobs.shutdown()` — the worker is stopped.
5. `hub.closeAll()` — **before** `server.stop()`, because a stop that waits on open
   connections would wait out the entire drain timeout, and WebSocket clients are exactly
   the connections that never close themselves.
6. `server.stop()`, raced against the drain ceiling.
7. Shutdown hooks, then `markStopped()`.

**The invariant is one: everything holding a timer or touching the database finishes
before `persistence.close()`.** That is what `apps/server/test/shutdown.test.ts` asserts,
and it is the only reason that file exists.

`exit` is **injected**, not called directly. `process.exit(0)` is right in production and
would take the test runner down with it inside a test — so the one thing that must not be
hard-coded is the one thing that leaves the process.

**One trap found while working:** `Lifecycle.runShutdownHooks` runs hooks
**last-registered-first**. `main.ts` registers `providerOauth.stop()` then
`persistence.close()`, so the one that runs first is `persistence.close()` — the opposite
of how those two lines read. It is not harmful here (`providerOauth.stop()` only clears
timers), but it is stated in `shutdown.ts` rather than left implied, because the next hook
added may not be so indifferent.

### 2. Forward migration is tested with data in it

Every existing migration test starts from zero: an empty handle, the full list, then
assert the schema that comes out. That is the **install** case, and it is the easy case —
there is no data to lose.

The case an operator actually experiences is different: they ran a build a month ago,
their database holds rows, and they pull a new build. The server migrates at boot with no
separate step, so a migration that drops or rewrites a column does its damage before
anyone is watching — and its first symptom is missing data on a page, days later.

The test deliberately builds an **old** database: apply a prefix of the shipped list
(`upTo(3)`, `upTo(15)`), fill rows into the tables that exist at that point, then run the
full list as boot would. What is asserted: the rows are still there and still mean the
same thing.

Two migrations that `alter table` get this treatment, and both are covered: `0004` adds a
pool column to `provider_accounts`, and `0016` adds Token Saver columns to `requests`.
Other migrations only create tables, and the install case already covers that.

Two mutations prove the test works: a `0016` that rebuilds `requests` (dropping rows) and
a `0004` that adds `in_flight` with a default of `1` instead of `0` — the latter would make
every old account appear to have an in-flight request, and that is the kind of damage that
does not show up as an error at all.

### 3. Archives are tested through files, not through objects

`system-routes.test.ts` already covered the round trip, but entirely in memory: the
archive is parsed from the response body and handed straight back. That tests the
_handler_, and it is a good test — but it never touches disk, and what the operator
actually does is save a file and load it again later, possibly on another machine,
possibly after editing it.

The gap is specific: **JSON that survives a round trip through an object is not the same
JSON that survives through a file.** `Uint8Array`, `Map`, or a value whose `toJSON`
disagrees with `JSON.stringify` all round-trip fine in memory and change shape on disk.

### 4. "Import without duplication" is true because restore replaces

`requests` and `request_captures` are in the restorable set, and restore **replaces** the
tables it names rather than merging into them — so applying the same archive twice leaves
the same row count. That is a claim worth testing: a restore that merged would double
every row, and nothing in the suite would say otherwise.

The other side of the same coin, and the part the operator has to know: restore **is not
additive**. Telemetry the archive does not have will be lost. That is tested too, because
"without duplication" read as "safe to merge" is an expensive misunderstanding.

### 5. What **cannot** be verified here, and it is stated

Delivering a signal to `process.on('SIGTERM')` **does not work on Windows**. Tested
directly: a Bun child process with `SIGINT`/`SIGTERM` handlers receives neither from
`child.kill(...)`, and stays alive. So the shutdown order is verified by unit tests with a
real `Lifecycle`, while **the signal delivery itself has never been observed on this
machine**. That is a platform limitation recorded since C1, not something D2 introduced.

What **can** be verified, and has been: the server boots cleanly after `main.ts` was
reworked — migrations 1–16 run, `rutekit listening` appears, and there is no regression on
the boot path.

## Consequences

**Positive**

- The shutdown order is finally held by something. A D1-class bug now fails a test instead
  of becoming an unhandled rejection.
- Forward migration from a populated database is tested for both table-altering migrations,
  with mutations proving the test bites.
- Archives are proven to survive the trip through disk, and "without duplication" is
  asserted rather than assumed.
- `main.ts` shrinks: the order can be read as one page instead of scattered inside a
  470-line function.

**Negative / risk**

- **Signal delivery has never been observed on Windows.** The handlers are correct per unit
  tests; that the OS actually calls them on this machine is unproven.
- **`main.ts` still has no tests.** What was extracted is the shutdown order, not the boot
  path. A regression in the dependency assembly would still slip past the suite — and now
  it is only noticed because I run the server manually.
- **Shutdown hooks run in the reverse of how their registration reads.** Documented, not
  fixed; fixing it would mean changing behavior for cosmetic gain, and `Lifecycle` already
  states the rule.
- **The old-migration test uses a `filter`ed migration list.** It proves "schema version N
  - data survives to the last version", not "a database written by an old build survives" —
    there is no real old database file in this repository.
- **The archive-through-file test writes into the test `dataDir`.** It cleans up with that
  directory, but a test that fails mid-way will leave a file in temp.
- **`restore` is not additive, and that can surprise.** Tested and recorded in the ADR, but
  the UI does not say anything about it yet.

## Rejected Alternatives

| Alternative                                         | Rejected because                                                                        |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Leave the shutdown order in `main()`                | The D1 bug lives exactly there; nothing holds it                                        |
| Refactor all of `main()` into `createRuntime()`     | Much bigger than D2, and touches a boot path no test has ever run                       |
| Test shutdown without a real `Lifecycle`            | What is under test is the interaction with hooks and the state machine, not a mock call |
| Call `process.exit` directly                        | Takes the test runner down with it                                                      |
| Only spot-check the order                           | The order is the whole subject; two swapped steps would pass                            |
| Fix the hook order to match how it reads            | Changes behavior for cosmetic gain                                                      |
| Old-migration test using an old DB file in the repo | A binary in the repository, and it rots with every new migration                        |
| Test forward migration without data                 | Exactly the easy case; proves nothing about data                                        |
| Backup/restore in memory only                       | JSON that survives through an object is not necessarily the same through a file         |
| Build separate telemetry export/import              | Not in the PRD; the archive already carries it, and restore already replaces            |
| Make restore merge so it is "safe"                  | Doubles every row, and nothing would tell anyone                                        |
