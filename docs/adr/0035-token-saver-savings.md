# ADR-0035 — Token Saver savings: one JSON column, measured around the pipeline, and "not running" is not "zero"

Status: **Accepted** · Date: 2026-10-14 · Related decisions: FR-1.2, A3, ADR-0023, ADR-0034

## Context

C14 is not a planned group. It was found by `apps/server/test/contract.test.ts` in D1:
the server registers **81 of 83** `consolePaths`, and the two missing ones are the
entire Token Saver console backend. The Token Saver page **404s against the real
server** — it only works against the mock, whose handlers have been complete since
PHASE B.

So the work is two things, at very different levels of difficulty:

- **Config** (`GET`/`PATCH /token-saver`) — wiring. `createTokenSaverSettings` already
  exists with `read()`/`write()`, `deps.tokenSaver` is already in `AppDeps`,
  `tokenSaverConfigUpdateSchema` is already in the contract.
- **Savings** (`GET /token-saver/savings`) — a feature. `packages/compression` has been
  producing `StageReport[]` with exactly the fields the schema asks for since the
  pipeline was written, but **the call site takes `.request` and discards the rest**.
  Nothing ever stored it, so nothing can read it.

## Decision

**One nullable JSON column on `requests`; measured around the pipeline only; and
"the pipeline did not run" is stored as NULL, not as a zero report.**

### 1. One column, not a child table

`requests` gains a nullable `token_saver_savings` column holding
`{ tokensIn, tokensOut, tokensSaved, stages: [...] }`.

The reason is the invariant `telemetry/recorder.ts` already holds: **a turn is written
once, when it ends.** A child table would mean N rows written at that same moment, and
the two could then fall out of sync — a turn with three stage rows and no parent, or a
parent whose stages were half-written by a crash. One column cannot be half a turn.

Its side effect is just as important: **retention needs no new code.** `deleteOlderThan`
deletes `requests` rows and their savings go with them; a child table would need a
cascade or a second sweep.

Per-stage aggregation is read with `json_each`, which turns one document per turn into
one row per stage — so the `group by` stays one query. It was tested working in
`bun:sqlite` before being chosen.

### 2. Measured around the pipeline, not around the function

`bytesIn`/`bytesOut` are taken **around `runPipeline` alone**, not around the whole
`outboundRequest`.

`outboundRequest` runs degradation, then the pipeline, then the phase-2 filter.
Measuring the whole function would give Token Saver credit for redaction done by the
operator's own filter rules — two different features, and this page reports one of them.

### 3. NULL means "not running", and that is different from "zero"

`storedSavingsOf` returns `null` when `stages.length === 0`, and the column is NULL.

**This is not a type detail.** `requestsProcessed` counts turns that were compressed. A
zero report would make a turn whose Token Saver was switched off indistinguishable from
a turn whose pipeline ran and could not shrink the body — and the "requests processed"
number would then count traffic the feature never touched.

It also means the column can `alter table ... add column` without a backfill: the honest
value for every old row is "the pipeline did not run", and filling them with zero would
claim Token Saver ran over traffic it has never seen.

### 4. `tokensOut` is derived, not converted

`tokensOut = tokensIn - tokensSaved`, not `bytesToTokens(bytesOut)`.

Per-stage numbers are floored (`tokensSaved` in `packages/compression` rounds down), so
their sum can be off by a token or two from the difference of the two sizes. Deriving
the output number keeps the headline arithmetic consistent with itself — **the bars sum
to exactly the total** — and that is what people check on a savings chart.

`bytesToTokens` was added to `packages/compression` and exported precisely so that the
four-bytes-per-token rule lives in one place. Two places that know that rule are two
places that can disagree.

### 5. The report is taken before the provider is reached

The `onCompression` hook is called in `callModel` **before the lease is taken**, not
after the answer.

What is measured is a fact about the _request_, and it is finished before the call is
sent. A turn that was compressed and then rejected upstream still saved those tokens,
and a savings number that counted only successful turns would quietly understate the
feature.

In the dispatcher, the report is stored on `TurnState` rather than read from the return
value, because a stream's row is written from `onStreamEnd` — long after `callModel`
returns. The reason is the same as for `target` and `ttftMs`, which are already there.

### 6. `failed` is not stored

`StageReport` carries `failed`, and it is discarded. A stage that throws keeps its input
verbatim, so it reports `bytesIn === bytesOut` and saves nothing — its failure is already
visible as "this stage saved zero". A flag that cannot be acted on differently exists
only to mislead.

### 7. A stage the contract does not know is dropped, not mapped

`orderStages` drops rows whose `stageId` is not one of `COMPRESSION_STAGE_IDS`.

The alternative — mapping them to a known id — would **attribute real savings to a stage
that did not produce them**, which is a chart that lies. Dropping makes the bars sum to
less than the headline, which is visible and recoverable. Besides, it cannot happen from
rutekit's own writes: the stored document is built from `StageReport`, whose `stageId` is
the same enum.

### 8. The Token Saver store now accepts a patch, like the two C13b stores

`write()` used to take a full `TokenSaverConfig`, and the route had to merge it itself.
Now it takes a `TokenSaverPatch` and uses the same `mergePatch` as customization and
general-settings.

Not tidiness: the console PATCH schema makes every field optional, so a page that flips
one switch sends one field. A write that replaced the record would **reset `enabled`** —
the switch the whole feature depends on — every time the operator changes the Caveman
tier.

### 9. A limit that was found here and closed afterwards

Found while working, and recorded rather than left implied: at the time, **console chat
recorded no telemetry at all.** `ChatTurnDeps` had no recorder, so a chat turn wrote no
`requests` row — and because savings attach to that row, the page covered `/v1` traffic
only. The number it showed was lower than the savings actually happening.

**That was closed after this ADR was written.** The chat console now records telemetry,
including the compression report, so a console turn writes its own `requests` row and its
savings are counted with everything else. `apps/server/test/chat-telemetry.test.ts` asserts
it, including that a console turn increments `requestsProcessed`.

The paragraph above is kept because it is the record of what was found at the time, not a
description of the current state.

## Consequences

**Positive**

- The Token Saver page works against the real server: config, savings, and trend.
- `bun run check` is **green again** — and that means the D1 coverage gate (NFR-2) runs
  again. While the suite was red, vitest wrote no coverage report at all, so the threshold
  was not evaluated.
- The contract test is back to 38/38, with the two routes that were red now served.
- The savings arithmetic can be checked: the bars sum to the headline.
- Retention needs no new code.

**Negative / risk**

- **Aggregation reads JSON, not an indexed column.** Every query filters on `at` first, so
  the index that matters is still used — but `json_each` is a table scan over the rows
  that pass the filter, and that is slower than an ordinary `group by` on a column.
- **`bytesToTokens` is a four-bytes-per-token estimate.** Not any provider's tokenizer.
  The "saved" number is an estimate, and the page does not say so — the assumption lives
  in the `bytes.ts` comment and here, not in the UI.
- **No real savings have ever been measured in this environment.** There are no provider
  accounts (`RUTEKIT_ENCRYPTION_KEY` is empty), so the tests use a stand-in and
  artificially large bodies. Real numbers from a real provider have never been seen.
- **`series` is a full grid even for an empty install.** For the `all` window that means
  one point per day since the epoch; on a very old install, the array grows without bound
  until retention cuts it off.
- **There is no way to delete savings history** other than deleting the `requests` rows,
  which means losing the telemetry too.

## Rejected Alternatives

| Alternative                                    | Rejected because                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A `token_saver_stage_savings` child table + FK | Violates the "one turn, one write" invariant; needs a cascade for retention                  |
| Store per-row window aggregates                | The ratio becomes an average of ratios, not a ratio of totals — a different and wrong number |
| Measure the whole `outboundRequest`            | Gives Token Saver credit for the operator's filter redaction                                 |
| A zero report for "not running"                | `requestsProcessed` would then count traffic the feature never touched                       |
| Backfill zero on old rows                      | Claims Token Saver ran over traffic it has never seen                                        |
| `tokensOut` from `bytesToTokens(bytesOut)`     | The bars no longer sum to the headline                                                       |
| Copy the byte-per-token rule in two places     | Two places that can disagree about what a saving means                                       |
| Take the report after the answer               | A turn that was compressed and then rejected goes uncounted                                  |
| Store `failed` per stage                       | Cannot be acted on differently; only misleads                                                |
| Map an unknown stage to a known id             | Attributes savings to a stage that did not produce them                                      |
| Drop stage rows whose sum is off               | Hides the mismatch instead of leaving it visible                                             |
| `write()` still takes a full record            | A one-field PATCH resets `enabled`                                                           |
| Merge the patch with a loop in the route       | `mergePatch` already exists and already handles `undefined`                                  |
| Put the route in `routing.ts` or `tools.ts`    | One is about model names, the other about filters — neither is this                          |
| Give console chat telemetry here               | A bigger change than C14, and not what was asked for                                         |
