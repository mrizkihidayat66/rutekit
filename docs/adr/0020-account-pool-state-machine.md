# ADR-0020 — Account pool: a 7-state state machine, leases, and a unified check-in

Status: **Accepted** · Date: 2026-10-13 · Related decisions: FR-3.1–FR-3.6, FR-1.3

## Context

A single provider can have many accounts, and each account has its own life cycle:
credentials never yet used, an account currently serving a turn, an account currently
in cooldown because the provider replied 429, an account whose quota is exhausted, an
account that has failed repeatedly, an account rejected by the provider, and an account
switched off by the operator. An incoming turn must pick one account from that set, hold
it for the duration of the turn, and record what the provider said about it once the
turn finishes.

Three design questions arise from that:

1. **How many states, and who may move them.** Some transitions are rutekit's own
   observations (cooldown expires, failure streak accumulates), and some are operator
   decisions (switch an account off, quarantine). If both are written as a single set of
   transitions, the pool could wake an account a human deliberately switched off.
2. **Where the in-flight count lives.** That number changes on every turn start and
   finish, while a database row is an expensive place for something that lives a few
   seconds.
3. **How many round-trips are needed to keep accounts fresh.** Proving credentials are
   still alive, refreshing quota, and waking a parked account sound like three jobs.

## Decision

**A single 7-state state machine with one transition table; the pool picks accounts
through `acquire`, which returns a lease; the in-flight count lives in pool memory and
the database column is only its mirror; and one authenticated check-in per account per
interval answers all three freshness questions at once.**

### 1. Seven states, one table, two classes of transition

The states are: `pending`, `active`, `rate_limited`, `exhausted`, `error`, `banned`,
`disabled`. The table in `pool/state-machine.ts` is the only statement of which
transitions exist, and `canTransition(from, to)` reads it.

On top of that table sits `isAutomatic(from, to)`, and the difference is the heart of
this decision: **a legal transition is not necessarily one that may be taken
automatically.** No automatic transition leads to `disabled`, and none leaves
`banned` or `disabled`. Both are states only a human can open — `disabled` because the
operator deliberately switched it off, `banned` because the provider has already rejected
its credentials and trying again would only burn one more attempt.

`pending` deliberately has no edge to `rate_limited` or `exhausted`: credentials
never yet used cannot already have been cooled down by the provider. `banned` likewise
has no edge to a resting state, for the same reason in reverse.

### 2. A lease, not pick-and-forget

`pool.acquire(providerId)` is the only way to obtain credentials, and it
returns `AccountLease | null`. Null means **busy**, not broken: every
account of that provider is resting, exhausted, or already at its in-flight ceiling.
The caller decides what that means for the client (the dispatcher translates it
into `unavailable`).

A lease is settled exactly once: `succeed()` when the provider answers, `fail(error)`
when it does not. Its release is deliberately idempotent — a stream is settled when its
headers arrive, because that is the last moment the dispatcher can distinguish success from
failure, and a stream that dies afterwards must not decrement the count twice.

### 3. In-flight in memory, the column as a mirror

The pool keeps the in-flight count per account in memory, and the column
`provider_accounts.in_flight` is written only as a mirror. The console route reads
through `toAccount(row, inFlight)`, which takes that number as an argument instead of
reading the column.

The consequence is accepted: if the process dies abruptly, the column can go stale. But a
stale number in that column means nothing anyway — no turn is in flight after the
process dies, so a wrong mirror harms no one, whereas reading the column while alive
would always lag one write behind.

### 4. One check-in for three questions

Warmup does not run three timers. It performs **one authenticated GET per account
per interval** — a model listing, which is the cheapest authenticated call
almost every provider has — and the answer answers three things
at once: the credentials are still alive, where quota is moving, and whether a parked
account deserves waking. Burning tokens to prove credentials
is a cost the operator is entitled to refuse, and a listing proves the same thing
for free.

Providers whose discovery is `static` have no listing, and are probed at their base
URL — for a local runner, "is it alive" is precisely the question. Providers that
do not publish rate-limit headers are not a failure: the probe still proves the
credentials are alive, and the quota columns are left as the previous check-in
left them (`readQuota` returns null, not a row full of nulls, so that
`setQuota` does not erase a figure already known).

Check-in never throws. Its caller is a timer, and a rejection would only
reach an unhandled-rejection handler that can do nothing about it.

### 5. What the provider says about its account

`outcome.ts` translates the upstream answer into one of five effects, with
one rule: **an account is blamed only for what is actually the account's fault.**

| Answer                                         | Effect      | Account becomes                         |
| ---------------------------------------------- | ----------- | --------------------------------------- |
| 401, 403                                       | `ban`       | `banned`                                |
| 402                                            | `rest`      | `exhausted` (without cooldown)          |
| 429                                            | `rest`      | `rate_limited` (honoring `retry-after`) |
| 5xx, timeout, unclassified error               | `transient` | streak rises; `error` at the threshold  |
| 200, 400, 404, 422                             | `recover`   | `active` (streak cleared)               |
| 400 bad body, 404 no such model, shutting down | `ignore`    | unchanged                               |

`invalid_request` and `not_found` are ignored because both are about the request, not
about the credentials — parking an account for them would park a healthy account.
Conversely, a 400 and a 404 coming from a probe actually **prove** the credentials are
alive (auth passed, the request was wrong), so both are `recover` paths
that let an `error` account come back.

### 6. Two selection strategies

`sequential` honors the order the operator declared and does not rotate; the cursor
is returned as-is. `round_robin` picks among the set of accounts with the
fewest in-flight, and breaks ties by rotation. The round-robin cursor
indexes the free set, not the whole list, so a full account does not
take part in the rotation at all. The strategy is stored in meta and read fail-open: a
failed parse falls back to `round_robin`.

## Consequences

**Positive**

- One transition table means every mover — the pool, the console service, bulk actions —
  uses the same gate; no path can put an account somewhere that
  the pool's recovery cannot leave.
- Separating manual from automatic makes "the operator switched the account off" really
  mean something: no expiring cooldown or reset streak can wake it.
- In-flight in memory lets the console read the right number while alive, and
  the column remains as a mirror for after a restart.
- One check-in means probe traffic to providers is a third of three timers, and
  the three answers are guaranteed consistent with each other because they come from one response.
- An idempotent lease makes a stream that dies after its headers safe without the
  dispatcher having to remember anything.

**Negative / risks**

- **The `in_flight` column can go stale after a hard kill.** Accepted: a stale number after
  the process dies does not refer to any real turn.
- **The transition table is a contract that must be kept honest.** Adding a new state to
  the contract without adding its edges would make that state impossible to enter
  or leave; the cross-product test (`isAutomatic` ⟹ `canTransition`) holds that
  part back, but does not hold back a forgotten edge.
- **The probe is an authenticated GET to every provider every interval.** For an
  installation with many accounts that is real traffic; the interval is configurable
  (`RUTEKIT_WARMUP_INTERVAL_MS`) precisely for that.
- **Quota is only as accurate as the provider's headers.** A provider that does not publish
  rate-limit headers will never have a quota figure, and its window is derived
  from `resetAt - now`, so a provider with a sliding window will appear to have a
  short window.

## Rejected alternatives

| Alternative                                            | Reason for rejection                                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One set of transitions with no automatic/manual split  | The pool would wake an account the operator deliberately switched off on the next cooldown — a silent bug that only shows up in production                    |
| `inFlight` in a database column as the source of truth | Every turn start and finish becomes a database write, and readers still lag one write behind; memory is the right place for a number that lives a few seconds |
| Three separate timers (liveness, quota, recovery)      | Three times the traffic for the same information; all three are the same question at the same endpoint                                                        |
| A chat turn as the warmup probe                        | Burning tokens to prove credentials is an unnecessary cost — a listing proves the same thing for free                                                         |
| Parking an account on `invalid_request` / `not_found`  | Both are about the request, not the credentials; parking on them would punish a healthy account                                                               |
| Picking an account without a lease (fire-and-forget)   | The in-flight count would never come down on the error path, and the pool would shrink over the life of the process                                           |
