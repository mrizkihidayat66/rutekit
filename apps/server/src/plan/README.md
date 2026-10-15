# `plan`

What a client's model name actually means, and which candidates can serve a given
request (C5b/C5c, FR-1.3–1.6, ADR-0021/0022).

## What it owns

Two questions, answered in two steps. `resolve(modelId)` — "which models does this name
reach?" — is a pure function of the stored plan and is what `/v1/models` asks.
`resolveFor(modelId, request)` — "which can serve _this_ request, best first?" — is the
same candidates reordered by what the request needs. Keeping them apart is what makes
capability-aware routing honest: the listing must not change based on what a client is
sending.

## The files that matter

- **`plan.ts`** — `createPlanner`. `resolve` runs the fixed order
  **mapping → alias → combo → catalogue**; `rank` reorders by fitness then (only in
  low-stress mode) by price.
- **`mapping.ts`** — `rewriteModel`: the edge rewrite. First match wins; **only one rule
  runs**.
- **`capability.ts`** — `demandsOf`, `unmetBy`, `isChatIncapable`, `degrade`. The rule
  that a model is never swapped behind the client's back.
- **`order.ts`** — `orderChain`, `parseStrategy`: which combo entry is tried first.
- **`listing.ts`** — the `/v1/models` payload: catalogue + enabled aliases + enabled
  combos.

## Invariants and traps

- **The resolution order is fixed and documented in ADR-0021.** A mapping is the only step
  that can change the _question_; an alias is one hop, never a chain.
- **Every read is from the database, every turn.** There is no snapshot to invalidate, so
  a rule saved on the console is in force on the next turn.
- **Nothing here throws on bad stored data.** An unparsable regex, a combo entry naming
  nothing, an unreadable strategy column — each skips one record, never the turn (R5.5's
  fail-open reading applied to the plan).
- **The incapable candidates stay in the list.** `rank` puts capable ones first and marks
  each step's `degraded` list; it does not filter them out, so a chain can still fall back
  to a model that answers with a placeholder rather than failing the turn. `refused` is
  reserved for embedding models, which no degradation can make chat-capable.
- **Low-stress mode reorders, it does not substitute.** It sorts what the plan already
  contains, cheapest first, and only among equally-fit candidates — never reaching for a
  model the operator did not list.
- **Unpriced models sort last** (`Infinity`, not 0): treating an unknown price as the
  cheapest would make low-stress prefer exactly the models it knows least about.
- **A disabled alias/combo is not a name at all** — `enabledAlias` and the combo check
  return null rather than falling through.
