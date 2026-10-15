# ADR-0025 — Automation worker lifecycle: one worker per job, a pause that kills, host-owned deadlines

Status: **Accepted** · Date: 2026-10-14 · Related decisions: FR-5.1–5.12, ADR-0009

## Context

ADR-0009 decided that automation runs in a Node subprocess and speaks over stdio
JSON-lines. What was not yet decided is the shape of its lifecycle, and there four
questions have interlocking answers:

1. **What a worker is run for** — one job or one item. The protocol changes
   completely depending on the answer: `start` carries a job, or carries an item.
2. **What "pause" means.** A browser in the middle of a sign-in flow cannot be
   frozen. So "stop" has two equally honest readings with different consequences.
3. **Who counts the manual-input deadline** (FR-5.5). Two clocks counting the same
   interval are two clocks that can disagree.
4. **Who runs the retry loop** (FR-5.6). The process that can see whether an attempt
   failed in a way worth repeating, or the one holding the ledger.

## Decision

**One worker per job; pause kills the worker and returns the in-flight item to the
queue; the host holds the manual deadline; the worker runs the retry loop.**

### 1. One worker per job

`start` carries the whole job, and the worker runs inside it with its own
concurrency. The consequence in C7c: **one browser with N contexts**, not N browsers.
A Chromium launch is the expensive part, and a context is how Playwright is designed
to isolate concurrent sessions — so "one worker per job", which sounds heavier, is
precisely what makes it affordable.

What keeps the protocol small is this split: the host never tells the worker to start
the seventh item, because the worker already knows how to get there. The host sets up
the batch and reads its report; the worker does the running.

**An accepted consequence:** the worker holds more logic than it would if the host
scheduled per item. What pays for that is the test — `flow.test.ts` tests that policy
directly, and `jobs-worker.test.ts` runs a real process over a real pipe.

### 2. Pause kills, and that is the choice that was made

This is the only C7 decision made **against** the recommendation. The recommended
option was _drain_ — stop new items, finish what is running — on the grounds that
discarding a browser mid-flow means losing progress already paid for. What was chosen
is _freeze_: the worker dies now, the in-flight item returns to `queued`, and resume
starts it from scratch.

What is gained: **pause really is pause.** No browser still holds a socket while the
operator believes the work has stopped, and there is no window where a job claims
`paused` while still working.

What is paid, and this must be visible: **every pause repeats the sign-in currently in
progress.** For a batch whose items are mostly quick, that is imperceptible. For a
batch with long items, one pause can throw away several minutes of browser work — and
if that happens repeatedly, one SMS number can be rented twice (quota already paid
for). This is recorded here so that it is a decision that gets read, not a surprise
that gets discovered.

The implementation: `stopWorker` sends `cancel` then schedules `kill` after a 2-second
grace period, so the browser has a chance to close itself cleanly before being forced.

### 3. The host holds the manual deadline

The worker reports `needs-manual` along with `humanTimeoutSeconds` — the duration the
provider declares in its manifest, because that is the only part of the interval the
worker knows. The host sets `manualDeadlineAt`, computes it, and sends `abandon-item`
when it passes.

The reason is one sentence: **the countdown the operator computes in the UI and the
clock that decides must be the same clock.** If the worker computed it, the UI could
show 5 seconds remaining while the worker had already given up — and `manualDeadlineAt`
on the server would be a mere mirror that can differ from reality.

`abandon-item` differs from `cancel`: it discards one item and **the batch continues**.
A passed deadline is not a job failure, and it does not consume a retry — the operator
ran out of time, not the attempt.

The host also holds one more clock: a **readiness window** of 30 seconds. A worker
that never announces `ready` is a failed job, not a job that is starting — without
that clock it would sit `running` forever.

### 4. The worker runs the retry loop

The worker knows when an attempt failed in a way worth repeating, so the worker waits
out the backoff. The arithmetic is fixed and tested: a base of 2 seconds, multiplied
per attempt, capped at 15 seconds (FR-5.6).

**A failure not marked retryable is not retried at all.** A credential the provider
rejected will be rejected again, and spending an attempt on it wastes a slot for
nothing. `RetryableError` is how a driver says "this could change if tried again".

The host records the `attempts` the worker reports, rather than deciding itself. That
column exists so the ledger survives if the process dies mid-item.

### 5. Snapshots are written when status changes, not at every step

Ten migration lines in `0008` store the job and its items. **Steps are not stored.** A
job of 200 accounts × 8 steps = 1600 rows, and every one of those rows has already
been sent to the console over the socket as it happened. Storing them would mean a
second copy of the live feed, kept for a reader who is not watching.

So steps live in the manager's memory and reach the console over the WS
(`job_step`); what survives a restart is the durable fact: which item is running, how
many times, and how it ended. An accepted consequence: a job from a previous process
has no steps, and its page shows the ledger without a timeline.

### 6. Worker death = job failure, item back to queued

If the process ends unprompted, the item that was running returns to `queued` and the
job becomes `failed` with a clear reason.

**There is no automatic respawn.** A worker that died from a bug will die again, and
automatic respawn only turns one failure into a crash loop that burns one attempt, and
possibly one SMS number, per iteration. The operator can `retry_failed` after fixing
the cause.

Items are returned to the queue because they were **interrupted, not judged** — a
retry must be able to pick them up, not start the whole batch over.

### 7. Recovery at boot

A job left `running` by a previous process has no worker behind it: no request lives
longer than the process that sent it, and the same holds for a subprocess. `recover()`
runs before readiness, marks those jobs `failed` with the reason "server restart", and
returns their in-flight items to the queue.

### 8. Payloads are stored encrypted

Batch credentials (`email:password`) live in `payload_envelope`, encrypted with the
same `SecretBox` as provider credentials. The read model never returns them — the
contract carries a masked label and a count, no more.

Keeping them is what makes `retry_failed` work after a restart. The "in memory only"
alternative is safer on disk but makes a failed job something you can only look at,
not repeat — and an operator who just lost 40 of 200 accounts wants to try again, not
read.

### 9. The browser driver sits behind a seam

`BrowserDriver` is the only interface between "how a batch is run" and "how a single
account is obtained". Above it, the entire lifecycle is identical between a real
browser and a fake — which makes orchestration testable deterministically without a
browser and without a provider.

The Playwright driver exists, and what is inside it is the mechanical part: launch the
engine the job asks for, exit through the proxy the host resolved, draw the window when
its mode says so, navigate to the start page, and take screenshots for preview. **What
is not there is any provider's flow** — the sign-in steps per provider have no common
shape, and inventing one before a provider is actually run is guessing. So the flow is
an injected `FlowScript`, and a job against a provider that has no flow yet fails with
a message that says exactly that.

## Consequences

**Positive**

- One browser launch per job, not per item — which makes concurrency affordable.
- One clock for the manual deadline, so the UI countdown and the server decision cannot
  disagree.
- Job failure and item failure are distinguished: the first returns items to the queue,
  the second consumes an attempt.
- Steps do not burden the database, and what survives is what is genuinely durable.
- Encrypted payloads make retry work across restarts without putting credentials in the
  read model.
- The whole orchestration is testable without a browser, and the boundary is tested
  with a real process.

**Negative / risks**

- **Pause repeats the sign-in in progress.** This is the price of "freeze", and it is
  recorded here as a decision, not a surprise. On a batch with long items or paid SMS
  numbers, one pause can throw away work already paid for.
- **The worker holds more logic.** Item ordering, retry and backoff live in a separate
  process; what pays for that is the test, not the structure.
- **No provider flow has actually been run.** The Playwright driver has never opened a
  real provider page — that is C7c, and until it happens "automation" means the
  orchestration, not a proven import.
- **Steps are lost after a restart.** Accepted: the timeline is a live feed, and the
  ledger is what survives.
- **`repoRoot()` uses `import.meta.dir`**, which belongs to Bun and not to Node. The
  server is what calls it, so it is correct in production — but the worker test has to
  compute its own root. This is a real runtime difference between the two processes.
- **Snapshot-on-status-change means an item that dies midway** is only recorded as
  `running`. Recovery is what cleans it up, and that is why recovery exists.

## Rejected alternatives

| Alternative                                                   | Reason for rejection                                                                                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One worker per item                                           | N Node processes, each with its own browser — heavy, and for C7c that means N Chromium launches                                                                         |
| Long-lived worker pool                                        | A browser from a previous job carries its cookies and state into the next job, and recovery is far more complicated                                                     |
| Pause as drain (the initial recommendation)                   | **Not chosen.** Saves more already-paid work, but an operator pressing Pause sees the job still working                                                                 |
| A pause that only stops scheduling, status stays `running`    | The Resume button never appears; the operator sees nothing change                                                                                                       |
| A worker that holds the manual deadline                       | Two clocks for one interval; the UI could show time remaining while the worker has already given up                                                                     |
| Both sides compute the deadline                               | Adds a path where the two can overwrite each other and is hard to test                                                                                                  |
| The host runs the retry loop                                  | The host would have to be able to tell the worker to repeat one item mid-job — adds messages and state, and moves the decision to a process that cannot see the browser |
| Snapshot at every step                                        | 1600 rows per 200-account batch, for a copy of a feed already sent over the socket                                                                                      |
| No snapshot at all                                            | FR-5.11 is not met and job history is lost after a restart                                                                                                              |
| Payload in memory only                                        | `retry_failed` cannot run after a restart — a failed job can only be looked at                                                                                          |
| Automatic respawn on worker death                             | A deterministic bug becomes a crash loop that burns quota every iteration                                                                                               |
| Leaving the job `running` when the worker dies                | A spinner that never stops for work that does not exist                                                                                                                 |
| Storing steps in the `jobs` table                             | One table for two different lifetimes: a durable ledger and a feed that lives for seconds                                                                               |
| A driver that knows every provider's selectors                | A file that changes every time one provider changes its page                                                                                                            |
| Inventing a `FlowScript` for every provider before any is run | Guessing, and the job would report a success that never happened                                                                                                        |
