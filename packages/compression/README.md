# `compression`

The Token Saver: five stages that shrink an outbound request before it reaches a
provider, and report what each removed. Governed by the fail-open rule (CONTRIBUTING
§5.5, RULESET R5.5); what its report becomes is ADR-0035.

## What it owns

The only place that decides what an outbound request may lose, and the only place that
says how much was lost. It reads and writes the pivot request from `@translator` and
performs no I/O — no provider, no database, no clock — which is what lets the whole
pipeline be exercised without a runtime standing behind it.

## The files that matter

- **`pipeline.ts`** — `runPipeline` / `applyPipeline`, and `runStage`, the guard. The
  stage order is the order `COMPRESSION_STAGE_IDS` declares, not a list kept here.
- **`types.ts`** — `CompressionStage`, `StageOutcome`, `StageContext`, `StageReport`,
  `CacheBoundary`: the shape every stage is written against.
- **`config.ts`** — `stageEnabled` / `activeStages`: the master switch, the per-stage
  toggle, and the two stages that are inert without their detail.
- **`bytes.ts`** — `requestBytes`, `bytesToTokens`, `tokensSaved`. The four-bytes-per-token
  rule lives here and nowhere else.
- **`tsc.ts`** — TSC, Tool Schema Compression: strips schema annotations (`title`,
  `examples`, `default`, `$schema`, the `readOnly`/`writeOnly` pair) and trims each
  description to its first sentence. `structural`.
- **`dcp.ts`** — DCP, Duplicate Context Pruning: drops an `assistant`/`tool` turn that
  repeats the one before it, and a text part a tool result already carried. `lossless`.
- **`rtk.ts`** + **`rtk-filters.ts`** — RTK, the tool-result filters: twelve detectors,
  each with a transform, tried in declaration order against only the enabled ones. `lossy`.
- **`caveman.ts`** — Caveman: the system prompt, tightened by tier
  (`lite`/`full`/`ultra`). `lossy`, and the only stage that touches the operator's own
  instructions.
- **`cache-markers.ts`** — Cache Markers: the only stage that shrinks nothing. It reports
  the two boundaries worth caching. `structural`.
- **`index.ts`** — re-exports only; a new stage is exported here too.

## Invariants and traps

- **Fail-open is two guards, and the second one is the one that matters.** `runStage`
  catches per stage so one failure does not cost the stages after it; `runPipeline`
  catches the run as a whole because the rule is unconditional. A stage that threw still
  gets a row (`bytesIn === bytesOut`, `tokensSaved: 0`, `failed: true`), but a run that
  threw yields `stages: []` — which `storedSavingsOf` reads as "the pipeline did not run"
  and stores as NULL. A misconfiguration costs the savings record, never the turn.
- **A stage that is off produces no row at all.** `activeStages` filters it out, so the
  report only describes stages that ran; there is no zero-filled row for a stage the
  operator switched off. RTK with no filter on and Caveman at tier `off` count as off,
  because calling them active would show savings that never happened.
- **`null` is "nothing to change", and it is the value the guard produces too.** That is
  deliberate: the pipeline cannot tell a stage that declined from one that threw, and does
  not need to — either way the previous request continues.
- **`StageReport.bytesIn` is the request as it entered that stage**, i.e. the previous
  stage's output. The rows are a chain, not five measurements of one request.
- **Savings are floored and never negative**, converted at four bytes per token because a
  token count is the provider's tokeniser and not ours: an estimate, not a measurement.
  `bytesToTokens` is exported so the savings record derives its "in" figure from the same
  rule — two places that know it are two places that can disagree.
- **Cache Markers reports a zero delta on purpose.** Its saving lands on the _next_
  request, so the stage's own byte count is unchanged and its ratio is zero. The boundary
  is reported alongside the request rather than written into it: the pivot has no field
  for one, and `extras` is spread straight onto the wire, so a marker there would reach a
  provider as an unknown top-level key.
- **RTK's filter order is load-bearing.** Narrowest shape first, first detector to match
  wins — a `git diff` also looks like a numbered read and a long text, so a filter that
  over-claims steals results from the one that fits better. No transform may throw: a
  filter that returns its input unchanged is cheaper than costing the pipeline a catch.
- **The measurement boundary is the pipeline, not the outbound body.** `model-call.ts`
  measures around `runPipeline` alone; the phase-2 content filters run after it, and
  folding their effect in would credit the Token Saver with a redaction an operator's own
  rule made.
- **Caveman never touches a fenced code block.** An instruction's example is data, and
  rewriting it would change what the prompt teaches.
- **`CompressionStage.nature` is declared but the pipeline never reads it.** The console
  keeps its own copy of the same fact, so the two can drift.
