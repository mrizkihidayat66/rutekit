# `pool`

The account pool: which credential a turn is sent as, and when an account stops being
usable (FR-3, ADR-0020).

## What it owns

The one place that chooses a credential and the one place that decides an account is no
longer fit to send one. It holds the live in-flight count in memory, runs the automatic
state transitions, sweeps resting accounts back to `active`, and hosts the warmup check-in
that proves a credential lives and refreshes its quota.

## The files that matter

- **`pool.ts`** — `createPool`: `acquire`/`inFlight`/`sweep`, the per-provider cursor, the
  in-memory live count, and the idempotent lease.
- **`state-machine.ts`** — the pure transition table (`TRANSITIONS`, `AUTOMATIC`),
  `canTransition`, `isAutomatic`, `isRoutable`, `parseAccountState`.
- **`outcome.ts`** — `outcomeFromError` / `outcomeFromStatus` and `createOutcomeWriter`.
  The mapping shared by the pool (which sees an `AppError`) and the warmup (which sees a
  bare status).
- **`selection.ts`** — `selectAccount`: `sequential` vs `round_robin` (least-in-flight
  first, ties broken by the rotation).
- **`strategy.ts`** — the stored load-balance mode, read fail-open from `app_meta`.
- **`warmup.ts`** — the periodic check-in, with its generation counter.
- **`quota.ts`** — reading `x-ratelimit-*` / `anthropic-ratelimit-*` headers.

## Invariants and traps

- **Two counts, and they are not the same count.** The **cursor** is per provider and
  survives across turns (it is what makes round-robin rotate). The **in-flight count** is
  per account, in memory only. `setInFlight` writes the column purely as a mirror for hand
  inspection; **nothing in rutekit reads it back**.
- **A lease settles exactly once.** `succeed` and `fail` are idempotent because a stream
  can die after its headers arrived. Double-releasing would leak capacity that never comes
  back.
- **`disabled` is manual-only.** `isAutomatic` is a separate set from `canTransition`, and
  encoding it that way is what makes it a guarantee: nothing the pool observes brings a
  `disabled` account back. Same for the automatic half of `banned` recovery.
- **`parseAccountState` returns null, never a default.** A row hand-edited into nonsense is
  skipped, not read as `active` and not silently rewritten.
- **The account is only blamed for what the account can be blamed for.** A mis-addressed
  turn or a client cancel is `ignore`d; a 400 from a probe means auth passed and is
  evidence the credential lives. Only a credential-directed refusal parks the account.
- **`warmup.stop()` bumps a generation counter**, not just clears the interval: a sweep
  already in flight checks `live(mine)` before every database touch, so it cannot read
  after `persistence.close()` (see ADR-0036 and `runtime/shutdown.ts`).
- **`sweep()` only moves `rate_limited` and `exhausted`**, and only when their clock has a
  value. An `exhausted` account with no `quotaResetAt` is waiting on the provider's window,
  which only a check-in can observe.
- **A new account is `pending`, and `pending` is not routable.** `pending` is the honest
  state for a credential nothing has used yet, and `pending → active` is an automatic move —
  but the only thing that makes it is a successful probe. So **an account nothing probes
  never takes a turn**: it exists, it was paid for, and routing skips it for ever.
- **A provider whose models are curated still needs a probe.** Discovery `static` means
  there is no listing to fetch, and the probe used to stop there — `listingPath` returned
  null, `probeRequest` returned null, and the sweep passed over the account without a word.
  Twelve providers were in that state, including the two with browser automation, so every
  account they imported stayed `pending` and was unusable. `discovery.probePath` is what a
  manifest names to fix that: the cheapest authenticated GET the provider answers, which for
  qoder is its quota endpoint and for kiro is `getUsageLimits`. A provider with neither a
  listing nor a probe path is asked at its base URL, which is right for a local runner.
- **Promotion is not credulity.** A probe that answers 2xx promotes `pending` to `active`; a
  401 or 403 still bans it. The two paths are the same outcome writer, which is why the fix
  above did not need to touch the state machine.
