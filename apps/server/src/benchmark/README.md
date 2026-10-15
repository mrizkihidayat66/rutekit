# `benchmark`

Running a promptfoo matrix over the instance's own endpoints, and reading the results
back (C11, ADR-0030).

## What it owns

One benchmark run from the operator's form to a stored matrix of cells. The whole shape
is: mint a key, write a config, spawn promptfoo, parse what it produced, store the
cells, revoke the key. Each of those is somebody else's job; this folder owns the order
they run in — and, crucially, the key's lifetime.

## The files that matter

- **`runner.ts`** — `BenchmarkRunner.start()`/`recover()`. The orchestration and the
  key's mint/revoke. Cells are written once, at the end.
- **`config.ts`** — turns the contract's variants × targets into promptfoo's
  `prompts × providers`. `planRun` also declares `expectedResultCount`.
- **`engine.ts`** — the child-process seam. Writes the config, copies the thin provider,
  spawns promptfoo with the key in the _environment_.
- **`results.ts`** — parses promptfoo's `results.json` (v3) into cells.
- **`catalog.ts`** — the two read models: the run list _without_ cells (a summary) and
  one run _with_ them.

## Invariants and traps

- **The key is revoked in a `finally`.** A run that fails, times out or is interrupted
  still gives its credential back. It is scoped to the run's models, so even mid-run it
  reaches nothing the run did not ask for.
- **Exit code 100 is success.** promptfoo answers 100 when the evaluation finished and
  some assertions failed — the ordinary outcome of a benchmark whose point is that
  models differ. Only other non-zero codes are failures.
- **A cell failed when the _call_ failed, not when the rubric did.** The signal is
  `response.error`. Reading promptfoo's own `success:false` or the row's `error` as
  "failed" marks every model that answered well-but-imperfectly as broken. This is the
  trap the parser exists to avoid.
- **`ttftMs` comes from the thin provider's metadata, never from promptfoo** — and a
  missing one stays null rather than being derived from latency.
- **The config file is JSON, and is still named `promptfooconfig.yaml`.** YAML is a
  superset of JSON, and `JSON.stringify` cannot produce a malformed document from
  arbitrary prompt text.
- **Every path handed to the child is absolute** — on Windows a relative `--output`
  makes promptfoo `mkdir('.')` and fail with `EEXIST`.
- **The key never appears on the command line or in the config**, only in the child's
  environment, so it never lands in a process listing or a log line.
- A missing promptfoo fails the _run_, not the boot: the error names what to install.
