# ADR-0016 — Dot trick: a standalone utility on the Tools page

Status: **Accepted** · Date: 2026-10-11 · Related decisions: D17

## Context

The "dot trick" exploits the rule that email providers ignore dots (`.`) in the
local part of an address — especially Gmail — and often also ignore the `+label` suffix.
A single original address can be expanded into many variants that all arrive in the
same inbox:

```
original: test@example.com
dot:    t.est@example.com, te.st@example.com, tes.t@example.com, t.e.st@example.com, ...
plus:   test+1@example.com, test+2@example.com, ...
both:   t.est+1@example.com, te.st+2@example.com, ...
```

This feature arises naturally alongside bulk account import (one email → many entries),
but **no comparable project in this space has it** — this is gap G1.

Two placement options were considered:

1. **A standalone utility page** under the Tools section.
2. **Integrated** as a toggle inside the bulk import form.

## Decision

**A standalone utility on the Tools page** (`/tools`), as the first of the page's three
sections (Dot Trick · VCC Pool · Filter Rules).

```
Input:   [ test@gmail.com            ]
Method:  (•) Dot   ( ) Plus   ( ) Both
Count:   [ 10 ]  Max: 32
[Generate]  [Copy All]  [Export CSV]

┌──────────────────────────────────┐
│ t.est@gmail.com            [copy]│
│ te.st@gmail.com            [copy]│
│ tes.t@gmail.com            [copy]│
│ t.e.st@gmail.com           [copy]│
│ ...                              │
└──────────────────────────────────┘
```

**Not integrated** into the bulk import form in v1.

## Rationale

| Consideration             | Why standalone wins                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Standalone usefulness** | Useful with no bulk import at all — e.g. creating many trial accounts, testing multi-account flows, or preparing a list of addresses. Locked inside the import form, it cannot be used for that. |
| **Complexity**            | Bulk import is already feature-dense (engine, concurrency, preview, manual assist). Adding an email generator inside it makes that form more complex without a proportional benefit.             |
| **Testability**           | The variant algorithm (especially `both`, which combines dots and plus) is pure logic that is easy to unit-test. Living in `packages/shared` with a separate UI keeps the boundary clean.        |
| **Reversibility**         | Adding an "expand emails" button in bulk import later only requires calling the same function. Conversely, dismantling a woven-in integration would be more expensive.                           |

## Limits & cautions

- **A maximum variant count (32)** to prevent a combinatorial explosion: dots in a
  local part with n characters yield up to 2^(n−1) variants, which explodes quickly.
- The generator **only builds variants**; it does not validate that the email
  provider accepts that variant. Gmail ignores dots, but many other providers do not.
- The UI shows a short note: dot behavior depends on the provider.
- The pure algorithm lives in `packages/shared/src/email-variants.ts`; the UI contains no logic.

## Consequences

**Positive**

- A differentiating feature that no comparable project has.
- Simple, tested, useful standalone.
- The integration path into bulk import stays open without a refactor.

**Negative / risks**

- Users may expect direct integration in bulk import and not find it.

## Mitigation

- The bulk import page shows a link to `/tools` ("Need multiple address variants?
  Use the Dot Trick tool"), so the path is discoverable.
- If user demand for integration is strong, a button in the import form can be added
  by calling the same function (see §Reversibility).

## Rejected alternatives

| Alternative                    | Reason for rejection                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Integrated only in bulk import | Limits usefulness; locks a general utility inside a single flow                                                                         |
| Both from v1                   | More code and UI surface to test; the added value of integration is unproven. Standalone first, integration follows if it proves needed |
| Not built at all               | This is a gap that was explicitly requested and exists in no comparable project                                                         |
