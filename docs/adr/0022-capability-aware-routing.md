# ADR-0022 — Capability-aware routing: reorder then degrade, and its limits

Status: **Accepted** · Date: 2026-10-13 · Related decisions: FR-1.6, FR-1.1, FR-1.4

## Context

FR-1.6 reads: _"if a model cannot express what is asked, drop the control or
substitute a placeholder — **do not** silently swap the model."_ That sentence
carries two different prohibitions, and both are easy to violate without realizing
it:

1. **Do not send a control the model does not understand.** Sending an image block
   to a model without vision is not a clean failure — the provider may reject it
   with a 400, or worse, ignore it and answer as if the image had never been there.
2. **Do not swap the model as a shortcut.** This is the most tempting: rutekit knows
   which models have vision, so "just bump it up to a capable model" feels like
   help. In reality it makes the operator lose control over which model actually
   answers, and produces a bill they did not expect.

Until C5b, the dispatcher had only one candidate, so this question had no place.
C5b gives a combo a chain, and there the question becomes sharp: if the first entry
cannot see the image and the second can, what happens?

Three design questions arise from that:

1. **Filter or reorder.** Dropping incapable entries upholds "don't use the wrong
   model" literally, but discards real availability.
2. **How visible the degradation is.** FR-1.6 forbids _silent_ substitution, so
   something must be visible — but the response body is not a free place (an SSE
   stream already has a shape the SDK parses).
3. **What "control" means for thinking.** An extended-thinking budget has no column
   in the pivot; it lives in `extras` under a different name per surface.

## Decision

**Candidates able to express the request are prioritized without dropping the ones
that cannot; the request is degraded in place for the model that is actually used;
and what was dropped is reported via the `x-rutekit-degraded` header plus a
structured log — the body is never touched.**

### 1. Reorder, not filter

`rank` in `plan/plan.ts` is the only place this order is determined:

```
candidates with degraded = []  →  prioritized, operator order preserved
candidates with degraded ≠ []  →  follow, operator order preserved
```

The reorder is **stable**, and that is what makes it predictable: if all entries are
equally capable (or equally incapable), the order the operator wrote does not change
at all. It only changes when there is a real difference in capability.

An incapable candidate **stays in the chain**. This is a deliberate decision:
dropping it means discarding availability that genuinely exists, and a chain whose
best candidate fails upstream should still be able to fall back to a model that
answers with the image replaced by a placeholder, rather than failing the turn. What
must not happen is silent substitution — and that cannot happen, because every step
carries its `degraded` list and the dispatcher reports it.

The "filter" alternative is rejected for the same reason: it trades availability for
a strictness FR-1.6 did not ask for. What is asked is not to be silent, not to never.

### 2. A model of the wrong kind is refused, not degraded

A model flagged `embedding` is not a model with lesser capabilities — it is the
wrong kind of model, and no amount of dropped controls can turn a chat request into
an embedding request. So it is **not** a fourth `ControlKind`:
`isChatIncapable` separates it, `rank` moves it out of the chain into `refused`, and
the dispatcher answers a `400 invalid_request` that names the model.

Refused locally, before any upstream call: no quota is burned, and the message names
which model is out of place rather than relaying the provider's words.

Inside a combo, this kind of entry is **skipped** rather than failing the turn — one
entry of the wrong kind must not cancel a chain whose remainder is correct.

### 3. Shape of the degradation: a placeholder that names its cause

| Control    | What happens                                                                                                               | Why                                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `vision`   | image block → text block `[image omitted: <model> cannot accept images]`                                                   | Removing it makes the model answer as if the user had attached nothing — a silent failure, exactly what is forbidden                           |
| `tools`    | `tools: []`, `toolChoice: null`; `tool_use` → named text; a `role: 'tool'` turn → a `user` turn containing its result text | Definitions left in place while their history is cleaned up is two contradictory statements                                                    |
| `thinking` | the reasoning budget is dropped from `extras`; thinking blocks are dropped from the history                                | A thinking block is the model's own reasoning, not the content of the conversation — a placeholder would put words there that nobody ever said |

Two details not visible from the table but deciding whether the result is correct:

- **Tool results keep their text.** The text is conversation content that already
  exists, and a model that cannot see the call can still read what was returned.
  Dropping it would be tidier on the wire and worse for the answer.
- **A `role: 'tool'` turn changes role too.** Every codec decides "this is the answer
  to a call" from `role === 'tool'` and renders it from the `tool_result` block. If
  the role is left while the block is dropped, what gets sent is an empty body with a
  `tool_call_id` for a call that is no longer in the transcript. The role is part of
  the rewrite, not a detail around it.

### 4. Reporting: a header, not the body

`x-rutekit-degraded: vision,tools` — a comma-separated list, in a fixed order
(`CONTROL_ORDER`), so the same degradation always reads the same.

A header, not a field in the body, and the reason is streaming: the SSE body is
provider frames re-emitted, and inserting one frame of rutekit's own means changing
the protocol the client SDK is parsing. The header sits outside that — read before a
single byte of body, the same shape for stream and JSON, and impossible to mistake
for the model's words.

The header is **absent** when nothing was dropped. An empty header would make every
client parse a value that says nothing.

A structured log (`model`, `dropped`, `requestId`) is written at `warn` level when
the degradation happens, so an operator can see it without having to intercept the
response. Per-request telemetry follows in C6.

### 5. Two entry points, not one

`Planner` has `resolve(modelId)` and `resolveFor(modelId, request)`, and that
separation is the heart of the design:

- `resolve` takes no request at all. It answers "which models this name reaches",
  and that is what `/v1/models` uses. The listing **must not** change depending on
  what a client happens to be sending.
- `resolveFor` answers "which models can serve _this_ request, best first", with the
  cost of each.

If the two were one function, the listing would depend on the request — and
capability-aware routing would leak into places it should not.

### 6. Degradation happens after the pivot, before the Token Saver

In the dispatcher, the order is: `ingest` → `resolveFor` → for each step: `degrade`
→ Token Saver → `encode` → call.

Degradation is placed there for two reasons. First, it works on the canonical form,
so one implementation serves all four surfaces. Second, the compression pipeline must
see the body that will actually be sent — not a body still carrying controls that are
about to be dropped.

## Consequences

**Positive**

- FR-1.6's prohibition is enforced on two sides at once: what is unsupported is
  never sent, and what is dropped is always reported. No path can swap the model
  without a trace.
- The operator's order is honored exactly unless there is a real difference in
  capability, so the reorder is never a surprise.
- Availability is not sacrificed: the chain can still fall back to an incapable
  model, with its cost stated.
- `resolve` and `resolveFor` separate "what this name reaches" from "what this
  request needs", so the listing and routing cannot contaminate each other.
- A model of the wrong kind is refused before any call, so no quota is burned for a
  request that cannot possibly be served.

**Negative / risks**

- **The placeholder changes the text the model sees.** Accepted and indeed the
  point; what matters is that the change is visible to the operator, not hidden.
- **`reasoning` is a proxy for thinking.** That manifest flag is the closest thing to
  "this model can use a reasoning budget", but it does not guarantee that its surface
  accepts `thinking.budget_tokens` — a provider that declares `reasoning` but has no
  concept of a budget will receive `extras` it does not recognize. Accepted: `extras`
  is precisely the path for parameters rutekit does not model, and a provider that
  does not recognize it will ignore it.
- **A model can look incapable when only its manifest is incomplete.** Capability
  flags are written by hand per model, so a model that can actually see images but is
  not flagged will be degraded. This is a visible error (the header names it) and is
  fixed by editing one manifest.
- **The header is not part of the `/v1` contract.** Client SDKs will not read it
  unless asked to. Accepted: FR-1.6 requires that substitution not be silent, and the
  header is the least invasive way to satisfy that without changing the provider
  protocol.

## Rejected alternatives

| Alternative                                               | Reason for rejection                                                                                                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filter incapable candidates out of the chain              | Discards real availability; FR-1.6 forbids _silent_ substitution, not degradation                                                                                           |
| Degrade in place without reorder                          | The first incapable entry would always beat the next entry that is actually a better fit — an operator writes a chain to reach a model, not to enforce an order at any cost |
| Swap to another capable model                             | Exactly what FR-1.6 forbids: the operator loses control over which model answers                                                                                            |
| Reject the request (400) instead of degrading             | Makes aliases and combos brittle — one model without vision cancels the whole turn, even though the chain could handle it                                                   |
| Drop image/tool/thinking without a placeholder            | The model answers as if the user had attached nothing; this is the silent failure FR-1.6 asks to avoid                                                                      |
| A degradation note inside the response body               | Changes the protocol the client SDK parses; on a stream it means inserting a frame that is not the provider's                                                               |
| Log only, without telling the client                      | A client that sends an image has no way to know the image was ignored                                                                                                       |
| `embedding` as a fourth `ControlKind`                     | No amount of dropped controls turns a chat request into an embedding request; this is a refusal, not a degradation                                                          |
| Forward the embedding model to the provider               | Burns one call for a request that cannot possibly be served, and the error message depends on the provider                                                                  |
| One `resolve(modelId, request?)` for listing and routing  | The listing would change depending on what the client happens to be sending                                                                                                 |
| Degradation not run before the Token Saver (after encode) | The compression pipeline would see a body that is never sent                                                                                                                |
