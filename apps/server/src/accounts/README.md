# `accounts`

The account pool's console surface (FR-3): the read model an operator sees, and the
hand-made state moves they are allowed to make.

## What it owns

Everything an operator can do to a stored provider account _from the console_ — list,
filter, sort, page, create by hand, edit, bulk-act, delete — plus the quota page's
read model. It does **not** own routing decisions or automatic state changes; those
belong to `pool/`. This folder is the seam between the two: a manual move is checked
against the pool's own transition table before it is written, so the console can never
put an account somewhere the pool's recovery would not recognise.

## The files that matter

- **`service.ts`** — `AccountService` (`list`, `create`, `update`, `remove`, `bulk`)
  and the `toAccount` projection. `move()` is the one gate a manual state change
  passes through; `applyBulk` implements the six bulk actions.
- **`quota.ts`** — `QuotaService.overview()` and `checkIn()`. Sums what providers
  reported per account, grouped by `windowSeconds`.

## Invariants and traps

- **The in-flight count is an argument, not a column.** `toAccount(row, inFlight)`
  takes the count from `deps.pool.inFlight(id)`. Never read `row.inFlight` — that
  column is a mirror the pool writes for hand inspection (ADR-0020), and after a hard
  kill it is simply wrong.
- **A manual state move goes through `canTransition`.** `move()` refuses an illegal
  transition with `invalid_request`. Adding a state to the UI without adding the row
  to `pool/state-machine.ts` will be refused, by design.
- **`disabled` is manual-only.** `rotate` and `disable` move an account to
  `disabled`; nothing here can bring one back except an explicit `enable`, which is
  also the only thing that clears the failure streak.
- **`reenable` clears the streak on purpose.** An account that left `error` with
  three failures behind it would be parked again by the next one — the operator's
  click would appear to do nothing.
- **A hand-added credential starts `pending`**, not `active`: the first turn or
  check-in is what proves it, and neither has happened yet.
- **Credentials are write-only.** `create`/`update` encrypt via `SecretBox` and
  `requireSecrets` throws when `RUTEKIT_ENCRYPTION_KEY` is unset. A blank credential
  in an update is "unchanged", not "erase".
- **An unreadable `state` column renders as `disabled`** (`UNKNOWN_STATE`), the one
  state nothing routes to — the safe reading for a row edited outside rutekit.
- **Bulk is per-row isolated.** One stale id must not lose the other forty-nine;
  `BulkResult.errors` names each failure.
- `quota.ts` `checkIn` is fire-and-forget: it starts the sweep and answers at once,
  because the console polls until `checking` clears. Do not await it.
