# `telemetry`

Per-request accounting: the row every Overview read model derives from (C6, ADR-0023/0035).

## What it owns

Writing one row per `/v1` (and console-chat) turn, capturing redacted payloads, and
turning those rows into the Dashboard, Usage and savings read models. Aggregation is done
in SQL at read time — there is no rollup table (see `persistence/requests.ts` for why).

## The files that matter

- **`recorder.ts`** — `TelemetryRecorder`: `begin`/`finish`/`capture`. Fail-open in the
  R5.5 sense — a telemetry write that throws must not turn a served request into a failed
  one.
- **`redact.ts`** — `redactPayload`: scrubs secrets by name _and_ by shape before a capture
  is stored.
- **`usage.ts`** — the Usage page's `summary`/`series`/`breakdown`, and `toRequestLog`.
- **`dashboard.ts`** — one request that answers every card on the Dashboard.
- **`savings.ts`** — the Token Saver's stored document and the window aggregate read model.
- **`cost.ts`** — `costOf(model, usage)`, USD from the manifest's two prices.
- **`window.ts`** — `windowRange`: window name → time range and bucket width.

## Invariants and traps

- **One row per turn, written once, when the turn ends.** That is the only moment every
  column is known (for a stream, usage arrives in the last frame). A row written at the
  start would have to be updated, and an updated row can be left half-written by a crash.
- **The recorder is fail-open.** Every method swallows its own errors into the log.
- **Payload capture is off by default.** When on, the stored body is redacted and carries a
  TTL — the redaction keeps the inspector from becoming a credential store; the TTL keeps
  it from becoming one later. The TTL lives in `general-settings.ts`.
- **Null is not zero, everywhere.** A turn whose provider reported no usage leaves the token
  columns null so it does not pull an average toward zero; `avgTtftMs` is null when no turn
  streamed; `costUsd` is null when the model carries no price (so "free" and "unpriced"
  differ).
- **`series` densifies.** A `GROUP BY` returns only buckets with rows; the read model fills
  quiet hours with real zeroes so a chart does not compress them out.
- **The Token Saver's stored shape is not the contract's shape.** A turn stores two sizes
  and the stage reports; the contract's schema is a window aggregate. Storing the aggregate
  per row and summing would make the ratio an average of ratios — a different, wrong figure.
- **`tokenSaverSavings` null means the pipeline did not run**, which is different from "it
  ran and saved nothing". Only turns the pipeline actually ran on are counted.
- **`ttftMs` and `latencyMs` are never combined**, and the cost figure bills cached input at
  the full input rate (an overestimate — the honest direction to be wrong in).
