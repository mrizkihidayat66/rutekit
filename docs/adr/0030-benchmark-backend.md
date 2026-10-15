# ADR-0030 — Benchmark: promptfoo as the engine, per-run scoped keys, and a "failure" that means the call

Status: **Accepted** · Date: 2026-10-14 · Related decisions: FR-9.1–9.4, ADR-0017, ADR-0029

## Context

C11 is the backend for the Benchmark page: one prompt template multiplied by N
variants, sent to M provider/model pairs, then compared. The roadmap asks for four
things — a `promptfooconfig.yaml` generator, spawning `promptfoo eval`, a thin
streaming provider for accurate TTFT, and run history + comparison.

ADR-0017 already decided _the engine_: promptfoo (MIT, usable as a dependency).
What was left undecided is the surrounding parts, and three of them are not
answered by the contract itself.

**How the child process authenticates.** Promptfoo runs providers in its own
process. That provider has to call something, and that "something" should be this
instance — but there is no clear way in for credentials.

**What "quality score" means.** FR-9.2 mentions it, `benchmarkResultSchema` has had
`qualityScore` 0–1 since PHASE B, but there is no rubric anywhere: nothing can fill
that column.

**What a failed cell means.** Promptfoo has its own opinion about this, and its
opinion is not what this contract intends.

## Decision

**promptfoo is installed and run as a child process; each run mints its own scoped
API key and revokes it at the end; a rubric is added to the contract; the run list
stops carrying its whole matrix; and a cell fails when the call fails, not when the
rubric is unsatisfied.**

### 1. promptfoo as a child process, with one Windows trap

`benchmark/engine.ts` is the seam: one interface (`run(request)`) and one
implementation. The child process is launched from `RUTEKIT_NODE_BINARY` with an
entrypoint resolved from its own package.

**Every path given to the child process is absolute.** Given a relative
`--output results.json`, promptfoo calls `mkdir(dirname(path))` — that is,
`mkdir('.')` — which fails with `EEXIST` on Windows and brings down the whole run
with "one or more output writes failed". This is not a style preference; it is a
platform difference found by an integration test, and absolute is the only form
that is correct on both.

**Exit code 100 is success.** promptfoo answers 100 when the evaluation finishes
and some assertions fail — which is the ordinary outcome of a benchmark whose whole
point is to find differences. Reading it as an error would report every run that
found something as broken.

**The resolver is `createRequire`, not `import.meta.resolve`.** `import.meta.resolve`
does not exist under the test runner, which replaces `import.meta` with its own
object — so resolution built on it works in production and fails silently in every
test, and a test that is silently skipped is worse than no test.

### 2. A per-run scoped key, revoked in `finally`

A benchmark is a client of this instance like any other client, so it authenticates
like any other client: the server mints one scoped API key (`modelsAllowed` = the
models that run requested), puts it in the child process's **environment**, and
revokes it in `finally`.

Three things make this correct:

- **`modelsAllowed` is a scope, not a suggestion.** Even while the run is going,
  that key cannot reach a model the run did not request.
- **The key never appears on the command line or in the config.** It travels only
  through the environment, so it does not show up in the process list and is not
  written to `promptfooconfig.yaml` — a file deliberately kept so the operator can
  re-run the YAML themselves.
- **`finally`, not the success path.** A key with no expiry is safe precisely
  because its revocation does not depend on the run succeeding. A run that fails,
  times out, or dies still returns its credentials.

**The alternative "the operator pastes their own key" is rejected** because such a
key is usually scoped more broadly than the run, and **the alternative "provider
credentials straight to the child process" is rejected** because the measured TTFT
would then belong to the child process, not to what the client sees through rutekit
— and the provider credentials would leak into a second process.

### 3. The rubric goes into the contract, and its three kinds are deliberately not promptfoo's vocabulary

`benchmarkInputSchema` gains `rubric`: a list of `contains` / `regex` /
`max_length`, at most 20. The contract owns this vocabulary, not promptfoo, so that
a run stays meaningful if the engine is swapped — the mapping to `assert` lives in
`benchmark/config.ts`.

**The score is the fraction that passes.** Three checks mean a cell can be worth 0,
⅓, ⅔, or 1, read directly from `gradingResult.score`. An empty rubric is a valid
run: it measures speed and cost, and its score column reads "—" — which is exactly
what `qualityScore: null` means in the contract.

**The alternative "leave it null" is rejected** because FR-9.2 would then be only
half filled — four of five metrics — and **the alternative "our own heuristic
score" is rejected** because a made-up score is worse than an empty one.

### 4. The run list stops carrying its matrix

`benchmarksResponseSchema` is now `pageSchema(benchmarkSummarySchema)`: a run
without `results`, with a `resultCount`. The detail stays the full
`benchmarkRunSchema`.

The list page only reads the cell count — "12 of 120 cells" — and carrying the
whole matrix would mean one page holding twenty runs × 120 cells is hundreds of
kilobytes of output nobody reads. The cost is a second shape that has to be kept in
sync, and that is paid once in `benchmark/catalog.ts`.

### 5. "Failed" means the call failed, not that the rubric was unsatisfied

This is the one place where two vocabularies almost collide, and both of
promptfoo's obvious signals are wrong:

- it writes `success: false` on **every row whose assertions did not all pass**;
- and it fills that row's `error` with **the reason the assertion failed**
  (`Expected output to contain "..."`).

Reading either as "this cell failed" would flag every model that answers well but
not perfectly as broken, throw away its score, and leave a score column that only
ever reads 1 or empty. Because comparing models that mostly answer well is **the
entire point of the rubric**, that reading destroys the feature.

The signal that actually means what it says is **`response.error`**, which
promptfoo fills only when the request could not be made. A row with no `response`
at all is treated the same — a cell that never even got a chance.

**This was found by an integration test, not by reasoning**, and that is why the
test exists: every other feature is tested through the seam, and the seam would
never show a difference in the meaning of a word on the other side of it.

### 6. A thin provider: a measuring instrument, not an SSE parser

`tools/benchmark-provider/provider.cjs` is dependency-free CommonJS copied into the
run workspace. It calls this instance's `/v1/chat/completions` with the run key,
reads the stream, and reports **two** numbers: `ttftMs` and `latencyMs`.

AP-10 warns about hand-written SSE parsers, and this deliberately is not one: it
reads `data:` lines, ignores the others, and looks at exactly two things — whether
a frame carries content, and whether it carries usage. There is no event
vocabulary, no buffering beyond a single line, and no behavior that could be called
translating a stream.

**TTFT is sent via `metadata`.** promptfoo has no column for it, so there is no
other way to carry it across the process boundary — and that is precisely why this
provider exists (ADR-0017). A cell without TTFT stores it as `null` rather than
deriving it from latency: a number nobody measured is worse than a number that is
not there.

**The provider calls rutekit, not the provider.** So what is measured is what a
client of this instance experiences: the pool picks an account, Token Saver runs,
the translator speaks the provider's dialect, and a telemetry row is written.

### 7. The workspace is kept

Each run has its own directory at `<dataDir>/benchmark/<run id>` holding the
config, the provider script, `results.json`, and its cache. It is **not** deleted
automatically: the YAML portability is what ADR-0017 wanted from the start, and an
operator who wants to know what actually ran just opens that directory and runs
`promptfoo eval -c promptfooconfig.yaml` themselves. `clearWorkspace` is exported
for sweeps, so that a sweep does not have its own `rm`.

### 8. The run is in-process, recovering as failed

Like Studio (ADR-0029) and unlike automation (ADR-0009): promptfoo is a child
process, but what supervises it is an async task in this server, not the whole
stdio protocol. `benchmarkRunner.recover()` is called once at boot and marks every
run still alive as `failed`.

## Consequences

**Positive**

- FR-9.1–9.4 are genuinely filled: the matrix runs, TTFT and latency are measured
  separately, the rubric scores, and run history is stored.
- The run key cannot be used outside its run, and does not live longer than it.
- A model that answers well but not perfectly still has a score, which makes the
  comparison table useful.
- The workspace YAML can be re-run outside rutekit.
- A missing promptfoo is one failed run with a sentence naming how to install it,
  not a server that refuses to start.

**Negative / risk**

- **promptfoo adds 76 direct dependencies** (express, winston, openai, mathjs, …)
  to the server's dependency tree, and ~32 MB to `node_modules`.
- **No real media provider has been tested yet** — as with C10: there are no
  provider credentials in this dev environment, so a real matrix has never been
  run against a real model. The integration test uses a stand-in that mimics the
  `/v1` surface.
- **No cancel.** promptfoo is a child process, and stopping it mid-matrix is a
  feature that has to be built, not a route to stub. A stuck run waits for its
  ceiling.
- **The whole matrix is written at the end.** promptfoo reports everything in one
  file, so the console sees `queued → running → succeeded` with no per-cell
  progress. That is why `expectedResultCount` exists.
- **`thinkingLevel` is not in the benchmark contract**, so every cell requests the
  model default. Recorded as a gap, not hidden.
- **Full output is not stored**, only a 400-character preview. A 120-cell run is
  hundreds of kilobytes of prose the console does not read.
- **The workspace is never cleaned up automatically**, so disk grows with run
  history.
- **CSV/JSON export happens on the page**, not on the server. One matrix rendering,
  not two that could differ.

## Rejected Alternatives

| Alternative                                        | Rejected because                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Postpone promptfoo, own runner first               | FR-9.1 could not really be exercised, and the quality score would have no source                          |
| rutekit runs the matrix, promptfoo only grades     | Reverses ADR-0017 and adds two phases that would have to be bridged                                       |
| The operator pastes their own API key              | Such a key is usually scoped more broadly than the run                                                    |
| Provider credentials straight to the child process | The measured TTFT would belong to the child process, and the credentials would leak into a second process |
| No rubric, `qualityScore` always null              | FR-9.2 would be filled for only four of five metrics                                                      |
| A rutekit-made heuristic score                     | A made-up score is worse than an empty one                                                                |
| promptfoo's assertion vocabulary in the contract   | A run stops being meaningful if the engine is swapped                                                     |
| `success: false` as the sign of a failed cell      | Every imperfect model becomes "failed", and the score column only ever reads 1 or empty                   |
| The row's `error` as the sign of a failed cell     | promptfoo fills it with the assertion reason too                                                          |
| `results` kept inline in the list                  | Hundreds of kilobytes per page that nobody reads                                                          |
| Relative paths to the child process                | `mkdir('.')` fails on Windows and brings down the whole run                                               |
| Treating exit 100 as an error                      | Every run that finds a difference is reported as broken                                                   |
| `import.meta.resolve` to locate promptfoo          | Not present under the test runner, so the test is silently skipped                                        |
| Workspace deleted after the run                    | Removes the YAML portability ADR-0017 asked for                                                           |
| Cancel as a stub route                             | Stopping the child process mid-matrix is a feature, not a stub                                            |
