# ADR-0027 — Tooling: a readable PAN, filter scope, and what "block" means

Status: **Accepted** · Date: 2026-10-14 · Related decisions: FR-11.1–11.3, SEC-6

## Context

C8 is three features that share only one page: dot trick, virtual card pool, and
content filter. Two of them raise questions their own contract cannot answer.

**VCC.** `vccCardSchema` has only `maskedNumber` and `last4` — there is no way out for
the full number. But FR-11.2 asks rutekit to **generate Luhn-valid cards**, and a card
whose number can never be read back is a card that cannot be used: the operator has to
type it into a sign-up form. So the contract and the requirement contradict each other,
and one of them has to move.

**Filter.** FR-11.3 asks for a two-phase filter, but does not say which text is
scanned. A canonical request contains more than prose: there are tool definitions with
JSON Schema inside them, there are tool results, there is a system prompt. Choosing the
scope is choosing between "too loose" and "damaging things that should not be touched".

## Decision

**The PAN is stored encrypted and readable through its own reveal endpoint; the filter
scans conversation text and the system prompt but not tool definitions; and `block`
rejects with a 400 that names the rule.**

### 1. The PAN is stored, and one endpoint reads it

`vcc_cards` stores `pan_envelope` and `cvv_envelope` through the same `SecretBox` as
provider credentials (R5.10, SEC-2). The read model never carries them — `maskedNumber`
is what the table displays, `last4` is the searchable key.

`GET /tools/vcc/:id/reveal` is the **only** path that opens the envelope, and it does
so for one card at a time. That is the shape of the need: an operator types one number
into one form, not exports the whole pool. It is its own path rather than a field on
the card, so that the decision to display a number is a request about one card.

**`hasPan` is a column, not a derivation.** A card the operator recorded by hand from a
masked form has no envelope, and "no number stored" is a fact the UI needs in order to
hide the button. Reveal refuses such a card rather than answering with an empty string
the UI would render as a card with no digits.

**The alternative — a ledger without reveal — is rejected** because it makes FR-11.2
cosmetic: the Luhn-valid number it generates cannot be used, and the feature stops being
anything but a calculator.

### 2. The CVV is stored alongside the PAN

A card that cannot produce a CVV is a card that cannot be used at the endpoint the pool
exists for. The two live and die together, so both are in the same envelope and come out
through the same endpoint.

The length follows the brand: three digits for Visa, Mastercard and Discover, four for
Amex — which prints it on the front and will reject a form asking for three.

### 3. The filter scans the conversation, not the request

What is scanned:

```
messages[].content[].text
system[].text
tool_result.content[].text
```

What is **not** scanned: `tools[].parameters` and `tools[].description`.

The reason is one thing: `parameters` is JSON Schema. A regex that matches inside it
would produce a schema the provider rejects with a 400 — a failure far from its cause,
and one the operator would look for in the wrong place. A tool definition is structure,
not prose.

This scope is also the easiest to explain: **the content of the conversation.** A secret
that leaks into the system prompt or into a tool result is caught; a word that happens
to appear in a schema property name is not.

### 4. `block` is a 400 that names the rule

```
400 invalid_request
"This request was blocked by the rule \"dangerous-content\"."
```

Not `permission` (403), even though "forbidden" sounds more semantically apt. The
reason is what the client reads: a 403 on `/v1` means a credential problem, and an SDK
receiving a 403 would report "my API key was rejected" for a request that is actually
legitimate. A 400 is a statement about the body, and the body is indeed what was
rejected.

**Naming the rule** is what makes it actionable. The operator who wrote the rule sees
which one fired; the client sees a rejection that explains itself. There is no upstream
call, so no quota is burned.

**The "just log it" alternative is rejected**: a rule named `block` that does not block
is a promise not kept.

### 5. Two phases, and the placement is the feature

Phase 1 runs **before** the compression pipeline; phase 2 **after**. That placement is
the reason two phases exist at all:

- phase-1 rules see the body **as the client sent it**;
- phase-2 rules see what **survived the pipeline** — where a secret reassembled from a
  compressed form would appear.

The test holds that directly: a phase-1 rule that redacts, then a phase-2 rule that
`block`s the resulting `[redacted]` string, both apply and in that order.

Within a single phase, **block beats redact**: a request that will be rejected does not
need to be rewritten first. Rules run in the order the operator arranged them, and a
`block` rule stops the step on the first match.

### 6. A broken rule does not bring down the turn

A regex that cannot be compiled **matches nothing**, rather than throwing. The
alternative — failing the request — would make one typo in one rule bring down every
turn that passes through. The console is where a bad pattern should be caught, and its
preview reports a non-match the same way.

Rules are read **per turn**, not captured at boot, so a rule the operator saves takes
effect on the next request.

### 7. Dot trick: power set, fixed tags, and an honest cap

A dot is a power set: a local part of _n_ characters has _n-1_ gaps and therefore
`2^(n-1)` spellings — ten characters is already 511. So the list is bounded by the
caller's `limit` with the contract's ceiling behind it, and the result **says whether
the cap truncated it** — a list that stops at 512 without saying so reads as "that is
all of them".

The plus tag is a **fixed set** (`rc`, `alt`, `probe`, `x1`, `s2`), not a generated
range: `+347` means nothing to an operator and the list becomes one nobody reads. Dots
fill the remainder up to the cap.

The two are **alternated**, so a cap that truncates still carries both kinds. Asking for
"both" and being given one page of dots is not an answer to the question asked.

### 8. The BIN catalog lives in code, not a table

The list of issuer ranges is a short curated list that changes when rutekit is upgraded,
not when an operator edits something. A table would buy a migration and a repository for
a list nobody ever writes to.

`acceptance` is the only evidence rutekit has about which ranges work, so "pick for me"
picks the highest one. A BIN that does not exist under the requested brand is
**rejected**, not ignored — a batch claiming the Visa brand under an Amex range is a
contradiction its request must not be able to state.

## Consequences

**Positive**

- FR-11.2 is genuinely useful: the generated number can be read and used.
- The read model never carries a PAN; reveal is one endpoint, one card.
- The filter cannot corrupt JSON Schema, so a rule cannot make a provider reject a
  request with a 400 that cannot be explained.
- A rejection names its rule, so the operator knows which one fired.
- A broken rule does not bring down the turn.
- The two-phase placement is tested through real `/v1`, not only in unit tests.

**Negative / risks**

- **The PAN and CVV are on disk.** Encrypted with `SecretBox`, but present nonetheless —
  and that is cardholder data rutekit did not hold before C8. Its reveal endpoint is the
  way out, and it sits behind the same session guard as the rest of the console.
- **A secret in `tools[].parameters` will not be caught.** Knowingly accepted: that is
  JSON Schema, and scanning it corrupts the tool.
- **Phase 1 runs over the raw body, so it sees nothing the pivot adds.** A field that
  exists only after ingest cannot be caught by a phase-1 rule; phase 2 catches it.
- **The dot trick can produce 511 addresses from one input.** That is the point, but it
  also means one request can produce many registrations from one mailbox — and the
  mailbox belongs to the operator, not rutekit.
- **The BIN catalog is written by hand.** A dead range or a new brand will not be
  detected until someone edits `bins.ts`.
- **No rule reordering in the console.** The order is creation order, which suffices for
  `block` (which stops on the first match) but not for arranging fine-grained priority.

## Rejected alternatives

| Alternative                                       | Reason for rejection                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Ledger only, without reveal                       | FR-11.2 becomes cosmetic: a Luhn-valid number that cannot be used                            |
| Do not store the PAN at all                       | Same: nothing usable, and nothing traceable                                                  |
| Reveal as a field in `vccCardSchema`              | Every list read would carry the number; the read model becomes a cardholder-data store       |
| PAN without CVV                                   | A card that cannot be used at the endpoint the pool exists for                               |
| The filter scanning every string recursively      | A regex matching in JSON Schema produces a broken schema → a provider 400 far from its cause |
| The filter scanning only messages, not system     | A secret that leaks into the system prompt goes uncaught                                     |
| `block` → 403 `permission`                        | An SDK reads a 403 on `/v1` as a credential problem                                          |
| `block` that only logs                            | A rule named `block` that does not block is a promise not kept                               |
| A single phase only                               | Loses rules that only make sense after compression                                           |
| A broken regex failing the request                | One typo brings down every turn                                                              |
| Rules captured at boot                            | A rule the operator saves does not take effect until a restart                               |
| Plus tags generated up to the cap (`+1`, `+2`, …) | The tags are meaningless; the list is unreadable                                             |
| Dots and tags concatenated instead of alternated  | A truncating cap gives one page of dots for a "both" request                                 |
| The BIN catalog as a table                        | A migration and a repository for a list nobody ever writes to                                |
| Ignoring a BIN that does not match the brand      | A batch claiming Visa under an Amex range is silently accepted                               |
