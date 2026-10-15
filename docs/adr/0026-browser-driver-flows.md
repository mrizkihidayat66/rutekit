# ADR-0026 — Browser driver: flow registry, captcha, stall, and the machine ceiling

Status: **Accepted** · Date: 2026-10-14 · Related decisions: FR-5.2–5.10, ADR-0009, ADR-0018

## Context

C7b built the orchestration: one worker per job, the stdio protocol, the manager, and
the `BrowserDriver` seam. What was still missing was anything that actually opens a
browser. C7c closes that, and once a real driver exists, four questions that could
previously be deferred become sharp:

1. **Where each provider's sign-in flow comes from.** ADR-0009 refused to put
   selectors in the manifest; C7b put a declarative `FlowScript` in the driver. Both
   are right and both are insufficient: a real sign-in flow is not a sequence of
   `fill`/`click`.
2. **What "silence" means for a worker** (FR-5.10), when one of the states FR-5.4 asks
   for — waiting for an operator — is genuinely silent.
3. **How the machine ceiling interacts with the number the operator enters** (FR-5.8).
4. **What a manual session does** (FR-5.7), given that the operator solves the
   challenge **in the browser**, not by typing the answer into rutekit.

## Decision

**A flow is a function that drives the page, registered per provider id; captcha is
detected from text and solved by the operator in the browser; a stall is silence that
is not waiting for an operator; and the machine ceiling is a ceiling, not a floor.**

### 1. A flow is a function, not a list of steps

`ProviderFlow` has `importItem(context)` which receives a `Page`. That is a change
from C7b's `FlowScript`, and the reason is a real sign-in flow: it waits for the page
to finish, reads a code off the screen, decides whether there is a challenge along the
way, and sometimes needs an operator's answer before it can continue. None of that fits
in a list of steps, and a list of steps grown large enough to hold it would be a
programming language.

The split stays the same as in ADR-0009: **the driver owns the browser, the flow owns
the page.** Everything above the flow — concurrency, retry, manual hand-off, the
protocol — is identical whichever flow is running.

### 2. An explicit registry, and no invented selectors

`flows/index.ts` maps provider id → flow, with three resolution rules:

1. an **explicit entry** for that provider;
2. the **device-code flow**, when the manifest declares `login: 'device-code'`;
3. **none** — and a failure that names the provider.

The second rule is not a fallback: a manifest that declares its login mode **has
already said** which flow it wants, so honoring it is reading the source of truth, not
inferring from it (ADR-0018).

**What is not there: selectors for a page that has never been seen.** The four
providers the frontend registers — kiro, qoder, codebuddy-intl, codebuddy-cn — are all
served by `generic-login`, a heuristic that finds the parts a sign-in form always has
(`input[type=password]`, an email field, a submit button) and **says so in its name**.
An invented selector is worse than none: it fails on a line that looks plausible, and
the operator reads a step name suggesting the page changed when nobody ever knew what
the page looked like.

Every step reports what it found, so a failure names which part is missing. That is
the difference between a useful heuristic and one that is merely opaque.

### 3. Captcha: detected from text, solved by a human

Detection is **page text**, not an image classifier. The signal is weak and still the
right one: a challenge page talks _about_ its challenge, and the alternative is an
image model — far larger to ship and maintain. The cost of the weakness is bounded in
both directions: a false positive parks an item for an operator who finds nothing, a
false negative makes the item time out; neither loses the batch.

**CJK markers are not decoration.** The catalog includes Chinese providers, and their
challenge pages are in Mandarin: `两步验证`, `双重验证`, `验证您的身份`. A detector that
only knows English would report "no challenge" on precisely the pages that most need to
be caught (FR-5.3).

**Two paths, and they do different things:**

- **The solver fills the fields itself.** An automatic answer is only useful if it is
  typed, so a solved challenge is filled in and submitted — and if the flow finds no
  field to put it in, the solve is wasted and the item still goes to a human.
- **The operator does not.** They solve the challenge **in the live browser** via a
  manual session (FR-5.7), and the answer is a confirmation that it is done. Filling
  the field here would be a second submission on a form they already submitted.

The solver is optional: without `RUTEKIT_CAPSOLVER_KEY`, every challenge goes to a
human. That is the correct default for an operator who has no account, and an image
never leaves the machine without consent.

### 4. A stall is silence that is not waiting for an operator

Five minutes with no frame at all → the worker is killed, the job fails, the item
returns to `queued` (FR-5.10).

**A parked job is not a stall.** A worker waiting for an operator to solve a captcha is
silent **by design** — it is the state FR-5.4 asks it to occupy — and a watchdog that
counted that silence would kill precisely the job that needs a human. So the check
stands down while `needsManual > 0`: the manual deadline handles it, and the stall
clock **re-arms** instead of stopping, so the job stays supervised.

Five minutes because a slow provider page and a long sign-in are both legitimately
silent for a while, and a shorter clock would kill work in progress.

### 5. The machine ceiling is a ceiling, not a floor

`effectiveConcurrency = min(requested, machineLimit)`, with the machine limit =
`min(cores - 1, freeMemory / 512 MB)`.

**Never raises it.** An operator who asks for one still gets one — running a single
item is how someone debugs a flow — and one who asks for twenty on a small machine gets
what the machine can carry. Two resources, and the stricter one wins: thirty-two cores
with 2 GB free still fits only a few browsers, and sixty-four GB free with two cores
gains nothing from a third context.

**The ceiling is reported.** `effectiveConcurrency` is populated only when the machine
is holding the number down, and the worker is sent the already-limited number. A silent
ceiling is worse than no ceiling: an operator who asks for eight and gets two would read
the slowness as a provider problem.

### 6. A manual session refreshes the view and extends the deadline

`POST /jobs/:id/session` is not an answer — it is the operator saying they are taking
over. The worker re-captures the page and reports its challenge again, which refreshes
the frame in the console and **restarts the deadline when that report arrives**. The
host still holds the clock, so this endpoint does not touch it directly.

Without this, someone who sits down to a challenge one minute before the deadline gets
only one minute to solve it — the wrong thing to hand to a person who has just started
working.

### 7. Two engines, and Camoufox genuinely installed

Chromium is the default; Camoufox (a hardened Firefox build) is for pages that decide
plain Chromium is not a browser. Both are lazily imported, and the engine is checked
before a batch starts — Camoufox needs a Firefox build downloaded to the machine, and a
machine that has not done so fails at launch with an install prompt instead of a job
error.

**Camoufox is installed and verified**, including its build: ~1 GB at
`%LOCALAPPDATA%\camoufox` on Windows. That is a per-machine setup cost the operator
needs to know about, and `engineAvailable` turns it into one sentence naming the
command instead of a batch failing item by item.

### 8. The proxy is on the browser, not the context

C7b set the proxy per context; C7c moves it to the browser. A job names one egress, so
every item in it exits through the same one — and that is the point, because the same
sign-in attempted from one address a hundred times is a pattern providers block. One
proxy per job makes the browser the right place. A job that wants to rotate per item
will move it back down.

## Consequences

**Positive**

- The machine is real: both engines verified opening a page, and flows tested against
  real Chromium, not a fake `Page`.
- No invented selectors. A failure names its provider, and a failing heuristic names
  which part is missing.
- The captcha detector covers the language of the providers actually curated.
- The watchdog does not kill a job that is waiting for a human.
- The machine ceiling is visible, so slowness can be distinguished from a provider
  problem.
- A manual session gives the operator enough time for work that has just begun.

**Negative / risks**

- **Not a single provider has actually been imported yet.** All four browser providers
  are served by a heuristic, and none of their pages has ever been opened. A job
  against them will run until the step that fails, and that failure is the signal that
  the provider needs its own flow.
- **Captcha detection is text, so it errs in both directions.** A challenge page in a
  language not on the list goes undetected; a phrase that happens to appear on an
  ordinary page parks the item. The latter was found by a test: `enter the code` parked
  every legitimate device sign-in, and it has been replaced with a more specific phrase.
- **Camoufox is ~1 GB per machine** and must be downloaded before the first job that
  asks for it.
- **Five minutes of stall is a guess.** A slow provider can exceed it, and a stuck
  provider will consume five minutes before being killed. There is no configuration for
  it; if it turns out to be wrong, that is the next setting.
- **`generic-login` fills the first field that looks like an email.** On a form with
  more than one, it can pick the wrong one, and the failure will look like a rejected
  password.
- **The captcha solver sends images to a third party.** Opt-in, but an operator who
  turns it on must know that.

## Rejected alternatives

| Alternative                                                                  | Reason for rejection                                                                                     |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A declarative `FlowScript` extended until it can hold a real flow            | Becomes a programming language; and still cannot express "wait for an operator"                          |
| Invented selectors for all four providers                                    | Fails on a line that looks plausible, and misleads the operator toward a page that changed               |
| The manifest carrying selectors                                              | ADR-0009 rejected it, and rightly: pages change without a provider definition changing                   |
| Image classification for captcha                                             | Far larger to ship and maintain, for a signal whose text is already sufficient                           |
| English-only captcha markers                                                 | Fails on precisely the providers that most need to be caught                                             |
| The operator entering the captcha answer via the API                         | The operator solves it in the browser (FR-5.7); filling the field is a second submission                 |
| Always trying the solver                                                     | Every captcha goes to a third party without the operator asking                                          |
| A stall without a `needs_manual` exemption                                   | Kills a job waiting for a captcha — precisely the state FR-5.4 asks for                                  |
| A heartbeat from the worker                                                  | Adds a message to the protocol to distinguish "long busy" from "stuck", which frames already distinguish |
| The machine ceiling as a floor too                                           | An operator who asks for one for debugging would get more                                                |
| A ceiling that is not reported                                               | The operator reads the slowness as a provider problem                                                    |
| A manual session that only refreshes the view without extending the deadline | An operator who has just started gets the previous person's remaining time                               |
| Proxy per context                                                            | A job has one egress; per-context invites rotation nobody asked for                                      |
| Camoufox as a plain Firefox alias                                            | The hardened build is the point; plain Firefox is not a meaningful second engine                         |
