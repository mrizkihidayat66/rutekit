# `tools`

The operator-run utilities: the content-filter engine, the virtual-card pool, the
dot-trick address expander (C8, FR-11.1–11.3, ADR-0027).

## What it owns

Three things an operator runs by hand rather than things the router does. Two of them —
the VCC pool and the dot trick — are pure utilities. The third, the content filter, is the
only part of this folder that runs _inside the data plane_: `filters.ts` is the engine the
dispatcher and the model call invoke, while `filter-service.ts` is its console CRUD.

## The files that matter

- **`filters.ts`** — `applyPhase`, `matches`, `redact`, `asRuleLike`: the pure filter
  engine. **`filter-service.ts`** — the CRUD, and `active()` which the pipeline reads.
- **`vcc.ts`** — `VccService`: generate, list, update, `reveal`. **`bins.ts`** — the curated
  issuer ranges. **`luhn.ts`** — check digit and grouping.
- **`dot-trick.ts`** — `expandEmail`: the capped dot/plus-tag variant list.

## Invariants and traps

- **The filter engine is pure and fails open.** A rule whose regex will not compile matches
  nothing rather than throwing — a typo in one rule must not take down every turn. The
  console's preview is where a bad pattern is meant to be caught.
- **What is scanned is the conversation, not the request.** Message text, the system prompt,
  and text inside tool results. Tool _definitions_ are **not** scanned — `parameters` is
  JSON Schema, and a regex matching inside it would produce a schema the provider rejects.
  That boundary is deliberate.
- **Phase 1 runs before compression, phase 2 after.** A phase-1 rule sees what the client
  sent; a phase-2 rule sees what survived the pipeline. The dispatcher and `model-call.ts`
  own the placement — do not run a phase anywhere else.
- **A `block` rule raises `invalid_request`, not `permission`.** A 403 on `/v1` reads to an
  SDK as a credential problem; the rule's name is in the message so the refusal explains
  itself. Nothing is called upstream, so a blocked turn costs no quota.
- **Rule position is the creation order** and a `block` stops the walk — so the order is
  meaningful. There is no reorder UI.
- **The VCC number is written once and read once.** Generation encrypts the PAN and CVV;
  `reveal` is the single path that opens an envelope, one card at a time. `hasPan` lets the
  UI hide the button on a card with no number behind it.
- **The VCC lifecycle is a one-way street.** A `used` card cannot go back to `active`, or a
  spent card would re-enter the pool for the next sign-up.
- **The dot-trick list is capped (512) and alternates dots and plus tags**, so a truncated
  list still carries both kinds. The result says whether the cap bit.
- **`bins.ts` is a curated list, not a table**, and its entries are the card networks'
  publicly documented test ranges.
