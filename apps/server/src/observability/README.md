# `observability`

The process's logger and the in-memory ring the console's log page tails.

## What it owns

The one logger the server writes through, and a copy of its output that the console can
read. It is deliberately small: logging goes to stdout as JSON, and the console log is a
_copy_ of that, not a replacement for it.

## The files that matter

- **`logger.ts`** — `createLogger`, `createLoggerWithRing`, `silentLogger`. The redaction
  list (`SECRET_FIELDS` / `REDACT_PATHS`) is the load-bearing part.
- **`log-ring.ts`** — `createLogRing(capacity)` and `entryFromLogLine`. A fixed-size ring,
  the console's filters, level counts, and the `logs` channel's subscribers.

## Invariants and traps

- **No transport, on purpose.** A pino transport runs in a worker thread, and the two
  lines that must always get out — the one written while draining and the one written for
  a boot failure — are exactly the ones a worker can lose. Collection is the deployment's
  job.
- **The redaction list is a security control, not a convenience.** Provider keys, session
  cookies, account tokens and the encryption key all pass through request handlers; a
  logger that wrote them would be a credential store. Any new secret field name must be
  added here (and to `telemetry/redact.ts`, which shares the discipline).
- **The ring is fed by the same passthrough that writes stdout.** Do not log twice (once
  for stdout, once for the ring): the two could disagree, and a console log that does not
  match what the process said is worse than none.
- **The ring is not a table, and that is a decision.** It is empty after a restart, which
  is the right behaviour for a tail. `total` counts what the ring holds, not what the
  process has ever said.
- **Level counts are taken before the level filter is applied**, so the tabs always add
  up — "how many warnings" means the same number whichever tab is selected.
- **Ordering ties break on arrival sequence, not the timestamp.** A single request
  routinely writes two lines in the same millisecond; a tail that sorted them arbitrarily
  would show a sequence that never happened.
