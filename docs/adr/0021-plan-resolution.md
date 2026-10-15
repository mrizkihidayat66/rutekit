# ADR-0021 — Plan: resolution order, combo fallback boundary, and cache-free plans

Status: **Accepted** · Date: 2026-10-13 · Related decisions: FR-1.3, FR-1.4, FR-1.5, FR-1.1

## Context

Until C5a, a single `/v1` turn knew only one thing about a model name: `ModelCatalog`
looked it up in the registry and answered which provider serves it. C5b added three
records that make that question no longer have a single answer:

- **alias** (FR-1.3) — a friendly name pointing at one real model;
- **combo** (FR-1.4) — one name that blossoms into a chain of ordered candidates;
- **model mapping** (FR-1.5) — an id rewrite at the edge, before anything sees it.

Three design questions arise from that:

1. **Which order is binding.** All three can point at each other: a mapping can
   rewrite to an alias name, an alias can point at a combo name. Without a fixed
   order, "what this name means" depends on the implementation rather than on the
   flow diagram already in CONTRIBUTING §3.3.
2. **How far a combo may fall back.** `comboSchema` has `fallbackOnError`, and the
   dispatcher holds a promise that cannot be withdrawn: once a 200 status and headers
   are sent to the client, the answer is committed. Starting a second upstream call
   after that means one request produces two answers.
3. **Where the plan is read from.** The tables are small, but they are read every
   turn.

## Decision

**The plan is resolved in the fixed order `mapping → alias → combo → catalog`; a
combo may fall back to the next entry only as long as no byte has reached the
client; and the plan is read from SQLite on every turn, with no cache.**

### 1. One order, and why

```
client id → mapping (first match, one rule) → alias (one hop) → combo? → catalog
```

- **mapping first** because it is the only step that changes the _question_, not
  the answer. Running it later means two ids circulate in the system at the same
  time.
- **alias before combo** because that is how the pipeline is drawn, and because
  that order allows composition: an operator who wants `fast` to mean a chain
  writes the combo, then one alias to that combo. The reverse order would make the
  two collide instead of compose.
- **only one alias hop.** An alias pointing at an alias is a loop waiting to be
  written; one hop is enough to name anything.
- **a combo wins over a model of the same name.** If one name is both a combo and a
  curated model, the combo is used — it is the operator's own construction and the
  more specific statement of intent.

`plan/plan.ts` is the only place this order is written. The dispatcher never calls
the catalog directly; it calls the planner, and the planner calls the catalog. That
is why the order cannot drift between one path and another.

### 2. The fallback boundary is commit-200, not "failure"

The dispatcher iterates candidates, and the boundary is the moment the answer
becomes a promise:

| Event                                             | May fall back to the next entry?                              |
| ------------------------------------------------- | ------------------------------------------------------------- |
| The provider wire cannot be translated by rutekit | Yes — nothing was sent anywhere                               |
| No account can take the turn (pool `null`)        | Yes — no upstream call, no quota burned                       |
| Upstream answers with an error before headers     | Yes — no byte to the client yet                               |
| Headers 200 (including stream) already obtained   | **No** — the answer is already committed                      |
| Stream dies after headers                         | **No** — that is the pump's business, not candidate selection |

What makes this boundary enforceable is the shape of `callProvider`: it returns a
`Response` as soon as headers arrive, and after that point there is no longer any
path in the dispatcher that can start a second attempt. The stream is primed before
the commit-200 (R5.7) for the same reason — if the first chunk never arrives, that is
still a failure before the promise, and the next entry may still be tried.

`fallbackOnError` is the gate, read as-is: **off means fail fast**, only the best
candidate is tried. That field defaults to `true` in the contract, so the deliberate
choice is the one that stops the step — and that is indeed what the switch in the
console says.

### 3. The plan is read per request, with no cache

Every turn reads three small tables from SQLite. The alternative — an in-memory
snapshot loaded at boot and rewritten every time a console route saves — eliminates
three `select`s but adds a path that can forget to invalidate once a new writer
appears. The turn itself already reads the API key row, the account row, and the
Token Saver record; three `select`s over tables of a few dozen rows is not
noticeable next to that.

The consequence is good and not a coincidence: **a rule saved in the console takes
effect on the next turn**, with no invalidation step that can be forgotten. The test
holds that directly (`plan.test.ts`, "reads every write on the next resolve").

### 4. The `/v1/models` listing answers a different question from the registry

Before C5b, "what a client can request" and "what a provider serves" were the same
question. C5b separates them, so the listing has three parts:

| Row           | `owned_by`          | `rutekit` block                                          |
| ------------- | ------------------- | -------------------------------------------------------- |
| curated model | provider            | full, `alias` names the alias pointing at it (or `null`) |
| alias         | its target provider | full, copied from the target model                       |
| combo         | `rutekit`           | **none**                                                 |

A combo gets no `rutekit` block because it has no single provider, single context
window, or single capability set — filling it in would mean claiming something
rutekit cannot support. `owned_by: 'rutekit'` is the only thing that is true about
every combo.

An alias pointing at a combo follows the same rule: a row with no block.

Aliases are listed by **asking the planner**, not by looking up their target in the
catalog. That is the point: an alias pointing at a combo is listed correctly too,
and the listing will never disagree with what a turn actually does.

An alias whose target is served by nobody is **not** listed: advertising a name
that will answer 404 is worse than not advertising it.

### 5. A name is an interface, so it stays put

`combo.name` and `alias.alias` cannot be changed via PATCH. The console already
disables the field on an existing record, so an API that accepts it must reject —
silently ignoring it would look like a successful rename. What can change is an
alias's target and a combo's contents, and that is indeed the useful part: a client
that cannot be changed keeps sending `fast` while `fast` is redirected.

### 6. An API key's model list is matched against both names

A candidate has two names: the id the client sent and the real model id.
`modelsAllowed` and `modelsDenied` are matched against both, and **deny wins on
both**. Without that, an operator who denies `gpt-4o-mini` is handing out an alias
that reaches it, and the denylist becomes a suggestion rather than a control.

Candidates the key may not use are **filtered out of the plan**, not made to fail
the turn: a chain whose first entry is out of scope starts from the second entry.

## Consequences

**Positive**

- One place writes the resolution order, so the dispatcher, the listing, and the
  console cannot disagree about what a name means.
- The fallback boundary is one observable fact (`callProvider` returns when headers
  arrive), not a convention every caller has to remember.
- No cache means no "the rule didn't apply" class of bug. Saving in the console
  takes effect immediately.
- The listing and resolution use the same planner, so what `/v1/models` advertises
  is what `/v1/*` actually answers.
- The denylist remains a control even with aliases and combos in between.

**Negative / risks**

- **Three `select`s per turn.** Accepted: the tables are small and the turn already
  reads several other rows. If the plan ever grows large, this is the first point to
  measure.
- **A combo can burn quota for more than one candidate per turn.** Accepted and
  indeed the point; what bounds it is `fallbackOnError` and the fact that an
  unavailable candidate is never called.
- **Regex mapping is operator input that gets executed.** An expensive pattern
  (catastrophic backtracking) will hold the event loop. Accepted for now because
  only a single operator can write it, and because an unparseable pattern is skipped
  rather than thrown.
- **A combo has no foreign key to its entries.** SQLite only enforces FKs with
  `pragma foreign_keys = on`, which is not set on the connection; a declaration
  without it is only a comment in disguise. A repository that deletes both in one
  operation is the guarantee that actually holds, and the test holds that.
- **`fallbackOnError` also gates fallback for availability.** A combo with
  `fallbackOnError: false` whose first candidate is in cooldown answers 503 instead
  of trying the second entry. That is the price of a literal "off means fail fast";
  the default is `true`, so this is the operator's deliberate choice.

## Rejected alternatives

| Alternative                                                        | Reason for rejection                                                                                                              |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| In-memory plan snapshot, refreshed on write                        | Adds an invalidation path that can be forgotten; three `select`s over small tables are cheaper than a class of bug                |
| Cache with a version counter in `app_meta`                         | Reads one table per turn to save three; the complexity is not worth it until the plan is genuinely large                          |
| Combo may fall back after commit-200                               | One request would produce two answers, and there is no way to withdraw bytes already sent                                         |
| Combo never falls back (pick one entry only)                       | Makes `fallbackOnError` in the contract and the console have no effect, and removes the main reason to use a combo                |
| Order `combo → alias`                                              | Collides instead of composes; an alias pointing at a combo becomes impossible, and that is the most useful composition            |
| Mapping also runs over `alias.target` and `combo.entries[].model`  | One id could be rewritten twice, and is hard to trace when debugging. Targets are written by the operator, so they are used as-is |
| An alias may point at an alias                                     | A loop waiting to be written; one hop is enough                                                                                   |
| Combo listed with a `rutekit` block                                | A combo has no single provider/context window/capability — filling it in is a false claim                                         |
| An alias that does not resolve is still listed                     | Advertising a name that answers 404                                                                                               |
| Deny matched only against the id the client requested              | An alias becomes a shortcut around the denylist                                                                                   |
| An out-of-scope candidate fails the turn instead of being filtered | A combo with one out-of-scope entry becomes useless, even though the chain can start from the next entry                          |
| Renaming a combo/alias via PATCH                                   | A name is an interface the client sends; a rename means retiring one name and introducing another, not editing a record           |
