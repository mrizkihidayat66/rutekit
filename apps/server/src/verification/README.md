# `verification`

Verifying what an endpoint actually is, in five stages (C12, ADR-0031).

## What it owns

The pipeline the roadmap names — **reachability → family → model → twin → claim** — the
probes it runs, the divergence measurements, the posterior that accumulates the evidence,
and the reference distributions a calibration writes. It is the third front door to
`providers/model-call.ts`, after `/v1` and the chat console.

## The files that matter

- **`service.ts`** — `VerificationService`: `verify` and `calibrate`, and the five-stage
  orchestration.
- **`probe-runner.ts`** — sends one probe via `callModel`, never via `/v1`.
- **`probes.ts`** — the probe catalogue and their costs. **`signals.ts`** — turns probe
  answers into a likelihood per candidate family.
- **`divergence.ts`** — Jensen–Shannon divergence over first-token distributions, with
  smoothing.
- **`families.ts`** — the hand-written family table and the capability `LADDER`.
- **`posterior.ts`** — the uniform prior, the multiply-and-normalise, and the band.

## Invariants and traps

- **It calls `callModel`, not `/v1`.** A benchmark measures what a _client_ experiences, so
  it goes through routing on purpose; a verification measures _the endpoint_. If the request
  went through the planner, an alias or mapping could send the probe somewhere else, and the
  Token Saver could rewrite the prompt — a verifier whose prompt was rewritten is measuring
  the pipeline. This is a deliberate departure from ADR-0030.
- **The claim earns no credit for being made.** The prior is uniform across candidates,
  including the claimed family (ADR-0017's second rule). A prior boost for the claim would
  let a reseller naming a family start every verification ahead — the exact failure this
  feature exists to catch.
- **A missing baseline is neutral (likelihood 1), not damning.** Treating "unmeasured" as
  "unlikely" would make a fresh install confidently declare every endpoint a mismatch.
- **`match` needs a model-level baseline on the claimed family.** A family baseline can
  confirm the family and can never confirm the exact build, so with only a family baseline
  the ceiling is `family-only`.
- **`insufficient` and `uncertain` are different.** `uncertain` is "the probes disagreed";
  `insufficient` is "the probes did not run". `MIN_MEASURED_SIGNALS = 1` is what makes a
  fresh install report `insufficient` — agreement among the four table-driven signals is
  agreement among constants, which is not evidence.
- **Two signals are strong and four are weak, and the code says which.** Only
  `single-token-distribution` and `tokenizer-surface` compare against something _measured_;
  the other four read the curated `families.ts` table and have deliberately gentle
  likelihood ratios.
- **A failed probe is an observation, not an exception** — a refusal is the whole of what
  the `api-surface` probe measures. Only a probe that could not be _sent_ is a run failure.
- **The probe text is never compressed or filtered.** This holds because a probe carries no
  tools, images or secrets — the file header flags this as a property of the probe text
  rather than something the runner enforces, and notes it as the one place a future content
  rule could quietly corrupt a measurement.
