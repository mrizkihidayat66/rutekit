# ADR-0019 — Pivot OpenAI with direct routes for fragile pairs

Status: **Accepted** · Date: 2026-10-13 · Related decisions: FR-1.2

## Context

rutekit stands between two worlds that do not talk to each other. Downstream there are
four different client surfaces — `chat/completions`, `messages`,
`responses`, `completions` — and upstream there is a set of providers that
each have their own wire dialect (`openai`, `anthropic`, `google`,
`custom`). Connecting the two directly means every pair
(surface × family) needs its own code: 4 × 4 = 16 paths, and the number
grows as soon as a new surface or family appears.

Two things make this problem more than a matter of multiplication:

1. **Token Saver (FR-4.x) works on the request, not on the bytes.** Its five stages
   (TSC, DCP, RTK, Caveman, Cache Markers) manipulate the _meaning_ of the
   request: tool schemas thickened with annotations, assistant turns that are repeated,
   text repeated inside tool results. A body forwarded verbatim cannot be
   compressed, because nothing knows where the tools are.
2. **Some provider answers must not be re-read.** Claude thinking blocks
   carry a `signature` that must come back byte-for-byte on multi-turn replay,
   and a pivot streaming event has nowhere to
   carry it. Vendor-specific response fields also disappear once an answer passes through the
   canonical shape.

## Decision

**The OpenAI canonical shape is the pivot. Every client surface is ingested into one
`CanonicalRequest`, and every provider result is decoded into one `CanonicalResult`.
That answer is rendered back out into the client dialect — except for two pairs, which
return the provider bytes as-is.**

The locked shape:

1. **One canonical shape in the middle.** N surfaces + M families need N + M codecs
   (ingest + render per surface, encode + decode per family), not N × M.
   Adding a new surface does not touch a single provider codec.
2. **Requests always pivot, without exception.** `chooseRoute` is called, but it
   decides the direction of the **answer**, not the direction of the request. The reason
   is Token Saver: a body forwarded verbatim is a body that cannot be compressed, and the
   two "exact" pairs are precisely the two most common pairs in the world. The cost of
   pivoting inward — fields the canonical shape does not yet know — is already paid by
   `extras`, which every codec spreads back into the body it assembles.
3. **The answer direction is a real decision.** `chooseRoute` returns
   `direct` for exactly two pairs: `chat-completions` + `openai`, and
   `messages` + `anthropic`. On a `direct` route the dispatcher returns the raw
   provider bytes (renderer `null`), so `system_fingerprint` or
   `signature` never passes through the pivot.
4. **The pivot applies to streaming too.** Every family has a stream decoder, and
   every surface has a stream renderer; the client receives events in its own
   dialect whatever family is behind it. For a Claude client, `message_start`
   is sent first (FR-1.2), because the client allocates its message from that
   frame.
5. **The error envelope follows the surface, not the namespace.** `surfaceForPath`
   picks the same renderer that the success path uses, so errors and results
   never disagree about dialect. A `/v1` that points to no
   surface (a wrong URL) uses the OpenAI envelope, because that is the
   namespace's dialect.

## Consequences

**Positive**

- Adding a client surface = one ingest + one render; adding a family = one
  encode + one decode. The multiplication is gone.
- Token Saver applies to every turn, because every turn passes through the
  canonical shape.
- The two fragile pairs (Claude thinking, OpenAI vendor fields) survive intact through a
  narrow, explicit `direct` route.
- The whole pivot can be tested without a socket: ingest and render are pure functions.

**Negative / risks**

- **A pivoted answer is lossy by construction.** Response fields that have no
  column in `CanonicalResult` are lost. `direct` is the escape hatch, and the
  list of exact pairs must be kept honest — adding a pair there
  means giving up compression for that surface.
- **`CanonicalRequest` and `CanonicalResult` become a contract touched by many.**
  One new field touches every codec. The discipline: add the
  field to `extras` until two families genuinely need it
  as a column.
- **The pivot has two paths that must stay in sync.** Streaming and non-streaming
  go through different code for the same result; tests must lock both.

## Rejected alternatives

| Alternative                                                        | Reason for rejection                                                                                                                                                                      |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A pure proxy: forward the client body as-is to the provider        | Token Saver loses its footing (it does not know where the tools are), and the 16 pair paths still have to be written for cases that are not exactly alike                                 |
| Pivot for everything, with no `direct`                             | Claude thinking blocks lose their `signature` on multi-turn replay, and vendor-specific OpenAI response fields are lost — two silent corruptions that stay invisible until a client fails |
| A third canonical shape as the only output                         | Clients speak their own dialect; forcing everything through rutekit's shape would mean every SDK in the world has to change                                                               |
| `direct` based on the family alone, not the (surface, family) pair | `messages` + `openai` is not an exact pair: the surface differs from the family, so forwarding bytes would send a dialect the client did not ask for                                      |
