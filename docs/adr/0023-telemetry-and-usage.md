# ADR-0023 — Telemetry: request table, read-time aggregation, ring log, low-stress

Status: **Accepted** · Date: 2026-10-13 · Related decisions: FR-12.1–12.4, FR-4.x, FR-3.6

## Context

Until C5, rutekit knew what was happening _now_: how many accounts are active, what
quota the provider last stated, which turns are in flight. What was still missing is
what has **already** happened. The Dashboard, Usage & Metrics, Console Log, and
request inspector pages in the frontend were built back in FASE B and already called
endpoints that had no real counterpart.

Four design questions arise:

1. **Where per-request telemetry is stored.** One turn produces one set of facts —
   status, latency, TTFT, tokens, cost — read by four different pages.
2. **How usage numbers are computed.** An hourly chart can be computed from raw rows
   on every read, or rolled up when the turn finishes.
3. **Where the console log lives.** A log is diagnostic and high-volume: one `debug`
   turn writes several lines.
4. **What low-stress mode means.** The switch in Dashboard and Settings has existed
   since FASE B, and its description reads _"prefer the cheap and the fast over the
   best"_ — but nothing reads it yet.

## Decision

**One `requests` table whose rows expire; all aggregation computed at read time with
`GROUP BY`; the console log is an in-memory ring buffer fed from the logger; and
low-stress mode genuinely reorders candidates by manifest price.**

### 1. One table, with retention bounding it

```
requests(id, at, method, path, provider_id, model, account_id, api_key_id,
         status, error_kind, latency_ms, ttft_ms,
         input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
         cost_usd, streamed, request_id)
```

One row per `/v1` turn, written **once, when the turn finishes**. That is the only
moment every column is known: status, latency, TTFT, and the usage the provider
reports — which for a stream arrives in the last frame, long after the headers. A row
written at the start is a row that has to be updated, and a row that is updated is a
row that can be left half-written if the process dies.

**The rows expire.** `telemetryRetentionMinutes` is an operator setting and a sweep
deletes what has passed, once a minute. That is what keeps a single-user instance's
database bounded **without a rollup table to keep in sync** — and it also bounds the
reads: a `GROUP BY` over one window will never scan more than that window can
contain.

The columns are nullable where the value genuinely may not exist, and the difference
is deliberate:

| Column                               | Null means                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `provider_id`, `model`, `account_id` | the turn failed before a provider was chosen — a 404 for an unknown model never gets anywhere |
| `ttft_ms`                            | a non-streaming turn, or one that failed before the first chunk                               |
| `input_tokens`, `output_tokens`      | the provider did not report usage                                                             |
| `cost_usd`                           | the model has no price in the manifest                                                        |

That last one matters: `0` and `null` are two different facts. A free local model and
a model whose price rutekit does not yet know both have no per-token cost, and a chart
that shows both as `$0` claims the second is free. `avg()` in SQL skips nulls, so
average tokens are not dragged toward zero by turns that were not measured.

**Failures are recorded too.** A rejected turn — unknown model, out-of-scope key,
invalid body — still gets a row. The operator asked for it and got nothing, and the
console must be able to show that. That is why `finishTurn` is called from the
`catch` in `complete`, not only from the success path.

### 2. Aggregation is computed at read time

`usage/summary`, `usage/series` and `usage/breakdown` are all `GROUP BY` over
`requests`, run when the page asks for them. The alternative — a rollup table
incremented when each turn finishes — would make every read one small `select` and
every write one extra write, and the two could then disagree: a turn whose rollup
update failed would be counted in the request table and missing from the chart, with
nothing able to reconcile them. Computing from raw rows means the chart cannot say
anything the table does not say.

**The bucket is computed by SQLite, and its format must match the caller's grid.**
`strftime('%Y-%m-%dT%H:%M:%fZ', (unixepoch(at) / step) * step, 'unixepoch')` —
`%f`, not `%S`. `%S` produces `HH:MM:SS` while `toISOString()` produces
`HH:MM:SS.mmm`, so the two sides would differ by three characters and **every bucket
would look empty**. This is not a hypothesis: it was a bug caught by a test and
produced a chart full of zeros.

**Gaps are filled.** `GROUP BY` only returns buckets that have rows, so a quiet hour
is absent rather than zero. A chart drawn from that list would compress the quiet
hours out and make one busy hour look adjacent to another six hours later — the
opposite of what a traffic chart is for. So the series is padded across the window,
from the same grid SQL computes.

### 3. The console log is a ring buffer, not a table

One 2000-line ring in memory, fed from the pino logger through a `Writable`
passthrough that parses each line and forwards its bytes as-is to stdout. **Not a
table**: one `debug` turn writes several lines, and inserting each of them into
SQLite and then running a retention sweep for them is a cost nothing pays for. The
ring is just a shift and a push, and the fact that it is empty after a restart is the
correct behavior for a tail — nobody reads yesterday's stdout from the dashboard.

The logger _tees_, it does not duplicate. The alternative — logging twice, once to
stdout and once to the ring — would let the two disagree, and a console log that does
not match what the process actually said is worse than no console log.

**`kind` is derived, not logged.** A line carrying `path` came from a route, one
carrying `accountId` from the pool, one carrying `model` from the dispatcher, and an
error is an error whatever it contains. Deriving it in the ring means the logger does
not need to remember to label every call site, and a new call site lands in a
sensible tab by default.

**The order is arrival order, not timestamp.** Two lines written in the same
millisecond — routine for a single request — would be ordered arbitrarily if only the
timestamp were used, and a tail showing them in the wrong order is showing an order
that never happened.

**Counts are taken before the level filter.** "How many warnings are there" must mean
the same number whichever tab is selected; a count that changes when the level tab
changes cannot answer that question.

### 4. Low-stress mode genuinely changes the order

When on, **equally capable** candidates are sorted by the manifest's
`inputPricePerMTok` as a secondary key, cheapest first. Two bounds:

- **Fitness remains the primary key.** No price makes a model that has to drop the
  client's image worth trying first. Price only breaks ties.
- **Never chooses a model outside the chain.** It reorders what is already in the
  plan and no more — the same boundary as C5c. A cheaper model the operator did not
  register is not a candidate, and reaching for it is the silent substitution
  forbidden by FR-1.6.

The reorder is stable, so among candidates tied on every key, the chain keeps the
order it was written in. **Models with no price are sorted last**, not first:
`Infinity`, not `0`. A model whose price is not yet known is not a free model, and
treating it as the cheapest would make low-stress choose precisely the models rutekit
knows least about.

The switch is read per turn from `app_meta`, not captured at boot — so flipping it in
the dashboard takes effect on the next request, not the next restart, the same rule as
the pool strategy.

### 5. Payload capture: redacted on the way in, with a TTL

The `request_captures` table is separate from `requests`, because the two have
different lifetimes: a capture lives 15 minutes while its row lives for the retention
period. One table would force the sweep either to delete telemetry too soon or to
keep bodies too long.

**Redaction happens before the insert.** Two passes, because there are two ways a
secret hides: **by name** (fields named `api_key`, `password`, `token` and so on, at
any depth) and **by shape** (values that look like credentials — a vendor prefix
followed by a real key length, JWTs, bearer schemes, and long opaque runs). The second
pass is what catches "someone pasted a key into the wrong field", which is not
hypothetical.

The opaque-run pattern requires **at least one digit**. Without that requirement it
catches every word or path fragment 28 characters long, and an inspector that redacts
the very request it was opened to show is worse than one that shows nothing.

**The TTL is enforced on the read path, not only by the sweep.** A row that has
expired but has not been swept must not appear in the panel; `capturesFor` filters on
`expiresAt >= now` itself.

Capture is off by default. When on, three of the inspector's five panels are filled:
the client body, the canonical pivot, and the upstream body. The client response panel
is not captured — that is the provider's answer, and the row already records its cost
and how it ended.

## Consequences

**Positive**

- One place every usage number comes from, so the chart cannot say anything the table
  does not say.
- Retention bounds the database **and** the reads at once, with no rollup table to
  keep in sync.
- Null vs zero separates "not measured" from "zero" in every average.
- The console log adds no write load to the database and cannot differ from stdout,
  because it is stdout.
- Low-stress mode becomes a promise kept, not a stored switch.
- Failures are recorded, so "what broke" has an answer from the same table as "what
  succeeded".

**Negative / risks**

- **Cost is an estimate, not a bill.** Cached input is billed at the full input rate
  because the manifest only has one input price. That overstates it, and the direction
  of the error is deliberate: an operator acting on a number that is slightly too high
  spends less than planned, not more.
- **`GROUP BY` scans raw rows.** Accepted for a single-user instance with minute-level
  retention; if the plan or traffic ever grows large, this is the first point to
  measure — and the answer is a rollup table, not a cache.
- **The log ring is lost on restart.** Accepted: a tail does start from now.
- **The ring is capped at 2000 lines**, so `total` counts what the ring holds, not
  what the process ever said. Accepted for the same reason.
- **Manifest prices are written by hand per model.** A model whose price changed but
  whose manifest has not will record a wrong cost. Visible in the table and fixed by
  editing one manifest.
- **The dashboard reads the process, not a metrics store.** CPU is an average since
  the process started, because `os.loadavg()` returns zero on Windows and an invented
  instantaneous number is worse than a correct average.

## Rejected alternatives

| Alternative                                            | Reason for rejection                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| In-memory ring buffer for telemetry                    | History is lost on restart, and the dashboard looks empty every time a new server starts               |
| Hybrid ring + periodic flush                           | Adds a path that can fail midway and creates two sources that can differ in content                    |
| Hourly rollup table                                    | The rollup can differ from its raw rows, and retention has to delete two tables on different schedules |
| Short-lived cache over the aggregation result          | Adds an invalidation path that can be forgotten; the numbers lag after a new request comes in          |
| `%S` for the bucket                                    | Differs by three characters from the `toISOString()` grid, so every bucket looks empty                 |
| Series only from existing buckets                      | Quiet hours vanish and the chart lies about the distance between events                                |
| Console log as a table                                 | High volume for diagnostic value; one `debug` turn writes several lines                                |
| Logger writes twice (stdout + ring)                    | The two can disagree, and a console log that does not match the process is worse than none             |
| Sorting the log by timestamp only                      | Two lines in the same millisecond are ordered arbitrarily                                              |
| Counts computed after the level filter                 | "How many warnings are there" changes when the tab is switched                                         |
| Low-stress as the last tie-breaker                     | Almost never applies to a hand-written chain, so the switch stays ineffective                          |
| Low-stress stored with no effect                       | The frontend already promises its effect in the Settings description                                   |
| Low-stress allowed to choose a model outside the chain | Silent substitution forbidden by FR-1.6                                                                |
| Models with no price sorted as cheapest                | Makes low-stress choose precisely the models rutekit knows least about                                 |
| Captures stored raw                                    | The inspector becomes a credential store (SEC-6)                                                       |
| Redaction by field name only                           | A key pasted into the wrong field slips through                                                        |
| Opaque-run pattern without a digit requirement         | Catches ordinary words and path fragments, so the inspector redacts the request it was opened to show  |
| Captures stored in one table with the request          | Two different lifetimes force the sweep to pick one                                                    |
| TTL enforced by the sweep only                         | Expired rows that have not been swept would appear in the panel                                        |
