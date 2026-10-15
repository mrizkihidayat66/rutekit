# ADR-0031 — Model verification: direct endpoint probes, an empty baseline, and a posterior that weighs only what was measured

Status: **Accepted** · Date: 2026-10-14 · Related decisions: FR-10.1–10.4, ADR-0017, ADR-0030

## Context

C12 is the backend for the Model Verification page: determine whether an endpoint
really is the model it claims to be. The roadmap asks for five things — a five-stage
pipeline (`reachability → family → model → twin → claim`), signals (one-token JSD
distribution, tokenizer probe, API surface, consistency check), **Bayesian**
accumulation of evidence into a family posterior, **fail-closed** discipline
(minimum 8 probes + 80% success rate), and a banded verdict that includes
`INCONCLUSIVE`.

ADR-0017 already decided the adoptions: port the JSD logic from
`ToseaAI/llm-fingerprint-detector` (MIT), the fail-closed discipline from `llm-verify`,
the tokenizer probe from `modelprint` — and **patterns only** for bazaarlink's
five-stage pipeline and the principle "never ask the endpoint its name".

Four things are not answered by the contract itself, and three of them only surface
once the implementation is running.

## Decision

**Probe through `callModel` directly, not through `/v1`; the baseline ships empty and
is calibrated by the operator; the posterior weighs only families that were measured;
and "measured" — not "usable" — is the fail-closed gate.**

### 1. A third front door: the probe calls the endpoint, not this instance

`verification/probe-runner.ts` is a third front door to `callModel`, after `/v1` and
console chat. It takes the second model as its pattern: the operator names the
provider and model directly, without an API key.

**This diverges from benchmark (ADR-0030) deliberately.** Benchmark measures what a
client of this instance experiences, so it goes through routing and compression.
Verification measures the **endpoint** — and if the request went through the planner,
an alias or mapping rule could send the probe to a different model than the one being
verified, and Token Saver could rewrite the probe prompt. A verifier whose prompt was
rewritten by the pipeline is measuring the pipeline.

**The probe is never compressed and never filtered.** `callModel` runs Token Saver
and the phase-2 filter, which is right for a turn and wrong for a measurement. Both
are inert here because the probe carries no tool, image, or secret — but the honest
statement is that this is a property of the probe's text, not a guarantee enforced by
this file, and it is the one place where a future content rule could silently break a
measurement. Recorded, not defended.

### 2. A failed probe is an observation, not an exception

A refusal is evidence — that is the entire content of the `api-surface` probe. So the
runner catches and records, rather than propagating. Only a probe that **cannot be
sent at all** (no free account, a wire that cannot be translated) becomes a run-level
problem, and that is reported as a stage failure.

### 3. The baseline ships empty, and the first verdict is `insufficient`

The `verification_baselines` table is empty on a fresh install. A signal that needs a
reference reports `No reference distribution for <family>` and its verdict is
`insufficient` with a note naming how to calibrate.

**The alternative "fill it with illustrative numbers" is rejected** because nobody can
verify those numbers without a real API, so the JSD would be computed against a
made-up distribution — exactly the false evidence the fail-closed discipline is meant
to prevent. A page that looks alive with made-up numbers teaches the operator to
expect verdicts they cannot get.

**The baseline lives in SQLite, not in a file.** The console can show which families
are calibrated, and calibrating one family does not touch another. `putBaselines`
replaces one subject in one transaction: a calibration that writes three of four
probes and then fails would leave a reference that is half old and half new, and every
JSD against it would be a number about two endpoints.

**The subject determines what can be claimed.** A subject naming a family
(`anthropic`) yields a family-level baseline; a subject naming a model
(`gpt-4o-mini`) yields a model-level baseline. That is the difference between
`family-only` and `match` in the contract — and `is_family` is stored, not derived
from the string, because nothing in `gpt-4o` says it is a model.

### 4. Only **measured** signals open a verdict above `insufficient`

This is the most important decision in C12, and it was born from two real test
failures.

Of the six signals, **four read a hand-written table** in `families.ts` — they can
confirm that an endpoint behaves the way rutekit believes a family behaves, and that
is not verification of any kind, because a model fine-tuned to imitate a family would
pass them all. Only the two distribution probes compare against a reference that was
**measured** from a real endpoint.

The first version computed the "usable" signals (`usable`) as the gate. That was
wrong: the four table signals are always usable, so an install with no baseline at all
went straight through the gate, and the verdict came out `uncertain` — a verdict about
a constant rutekit wrote itself.

Now `SignalResult` carries `measured` separately from `usable`, and
`MIN_MEASURED_SIGNALS = 1` is the gate. Without at least one signal comparing against
a measured reference, the answer is `insufficient` no matter what the four table
signals say.

### 5. Rivals are families that **can be measured**, not every known family

The second test failure, and the subtlest. The posterior splits its mass across all
candidates, so a family with no reference holding a full share of the prior is a family
that **evidence can never move**. With one calibrated family and three that are not,
the claimed family could never exceed a quarter of the mass — even if it reproduced
its reference exactly. The verdict would then never leave `uncertain`, which is the
wrong answer for an endpoint that matches perfectly.

The arithmetic cannot be fixed by raising the likelihood: to reach 0.7 with three
rivals, the likelihood ratio would have to be around 7, which means a JSD difference
far larger than anything that makes sense as a signal.

So the candidates are the claimed family plus the families rutekit has references for.
**A family that cannot be measured is not a rival**: rutekit has no basis to choose or
reject it, and pretending otherwise means inventing evidence from the _absence_ of a
reference. When nothing has been calibrated, the list falls back to the whole table —
which produces the flat posterior a fresh install should indeed display.

### 6. The claim gets no advantage

The prior is uniform across all candidates, including the claimed family. ADR-0017's
second rule is that an endpoint's self-identification is not evidence, and a prior
boost for the claim would smuggle exactly that back in — a reseller naming a family
would start every verification out in front, which is precisely the failure this
feature exists to catch.

### 7. `insufficient` and `uncertain` are two different things

`uncertain` is "the probes disagree". `insufficient` is "the probes do not work" or
"nothing was compared against a measured reference". Merging the two would let a
verification that spends six requests claim the same authority as one that spends a
hundred.

The gates are two: the count of measured signals (≥1) and the probe success rate
(≥80%, the number the roadmap names). An endpoint that answers four of five requests
is an endpoint that is failing, and the divergence from the fifth is not a sample
representing anything.

### 8. The family table is hand-written, and the verdict lives with that

Four families: `anthropic`, `openai`, `google`, `meta`. Each entry is rutekit's
statement about how a family usually behaves, not a measurement — the measurement is
the baseline, and the two are separate. That is why the table signals are **weak**
evidence, and the posterior treats them that way: `AGREES = 0.85` and
`DISAGREES = 0.25` are deliberately soft ratios, and a verdict resting only on them
cannot reach `match`.

A family that is not in the table is not thereby unverifiable: it gets a uniform prior
and only baseline-based signals can move it, so the honest outcome is `uncertain` or
`insufficient` — not a confident answer about a family rutekit has no reference for.

### 9. One signal was removed because the pivot cannot see it

`api-surface` was originally planned to read the provider's **error vocabulary**. That
is impossible: `upstreamFailure` rewrites upstream failures into rutekit's own
sentences before anything reads them, so a fingerprint read from an error string would
read rutekit's own words back.

What that probe reads now is **whether a known request that the family rejects is
actually rejected** — `n > 1` is rejected by Anthropic's Messages API and accepted by
the others. One bit, and an honest bit. This is also why `tokenizer-surface` is the
second distribution probe rather than a real tokenizer probe: the provider's tokenizer
does not cross the pivot.

### 10. The ladder reads the **last number** in the answer

A small rule with real consequences. A model that shows its work legitimately repeats
numbers from the question, so looking for the expected value anywhere would pass almost
everything; and looking for it as the only number would fail every model that works
step by step. The last number is where an answer puts its result — `"45 km and 30 km
give 75 km/h"` ends at 75, and `"It is 38 or 39"` ends at 39 and is correctly counted
as doubt, not a result.

## Consequences

**Positive**

- FR-10.1–10.4 are filled: six signals, the posterior, banded verdicts, and history.
- A fresh install cannot produce a confident verdict: `insufficient` is its first
  answer, with a note naming how to fix it.
- An endpoint that matches its reference can reach `match`, instead of being stuck at
  `uncertain` because of an uncalibrated family.
- The probe reaches the endpoint under examination, not the model routing happened to
  resolve.

**Negative / risk**

- **There is no real baseline in this environment yet.** `RUTEKIT_ENCRYPTION_KEY` is
  empty, so there are no provider accounts; calibration has never been run against a
  real model, and a real JSD has never been computed from a real distribution.
- **The family table is four hand-written entries.** A family outside the list cannot
  be discriminated; adding it is a code change, not configuration.
- **`self-consistency` is computed from four paraphrases**, so its split-half compares
  two against two. That is a thin sample, and the signal is reported with its sample
  count so that this is visible.
- **Refusal detection is a heuristic** over the opening of the answer. A model that
  refuses in an unusual way is counted as complying.
- **Probes run sequentially.** Forty concurrent requests to one account is the shape
  that trips the provider's own rate limit, which would look like missing samples and
  read as divergence.
- **There is no baseline deletion from the console.** Recalibration replaces; throwing
  a reference away entirely has no path yet.
- **`tau` and the band thresholds are round numbers that were chosen**, not results of
  measurement. This ADR says so rather than pretending otherwise.
- **Verification runs synchronously.** A `deep` budget is ~190 requests inside one HTTP
  request; it is bounded by its budget, not by a timeout.

## Rejected Alternatives

| Alternative                                           | Rejected because                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Probe through `/v1` like benchmark                    | An alias/mapping could divert the probe, and Token Saver rewrites the probe prompt |
| Provider credentials straight to the runner           | Bypasses the state machine and the pool lease                                      |
| Baseline filled with illustrative numbers             | A JSD against a made-up distribution is false evidence                             |
| Baseline in a JSON file                               | The console cannot read one family without the whole file                          |
| `usable` as the fail-closed gate                      | The four table signals are always usable, so an empty install passes               |
| Every known family as a rival                         | An unmeasurable family holds mass that evidence cannot move                        |
| Prior boost for the claim                             | An endpoint's self-identification is not evidence (ADR-0017)                       |
| Merging `uncertain` and `insufficient`                | A six-request verification claims the authority of a hundred requests              |
| Provider error vocabulary as a signal                 | `upstreamFailure` rewrites the message; it reads rutekit's own words back          |
| Provider tokenizer as a signal                        | The tokenizer does not cross the pivot                                             |
| Looking for the expected value anywhere in the answer | A model that works step by step repeats the question's numbers                     |
| Probes running concurrently                           | Trips the provider rate limit, reads as divergence                                 |
| Binary verdict                                        | The contract is banded, and this method cannot give more                           |
