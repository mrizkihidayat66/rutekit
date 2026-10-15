# ADR-0028 — Chat: two front doors, one call core

Status: **Accepted** · Date: 2026-10-14 · Related decisions: FR-7.7–7.10, ADR-0019, ADR-0020

## Context

C9 is the backend for the Chat page: sessions, transcript, and one endpoint that answers
with a stream. The page has existed since FASE B, built on MSW, and its mock handler
already wrote AI SDK UI Message frames — so the protocol was decided before C9 began.
What was missing is the server side.

Three things make C9 different from the previous groups.

**There are two entrances to the same provider call.** `/v1` arrives with a model name
and an API key, then the planner decides what that name means. The console arrives with
a provider and model the operator picked from a list, and has no key at all. Before C9
there was only one door, and the call implementation (`dispatcher.ts`) mixed "what this
name means" with "how to call one model". The second door forces that separation — or
doubles the entire call logic.

**The console does not send the conversation.** Its transport (`chat-transport.ts`) sends
one turn: what was just typed, and what was just dropped onto it. The transcript must
come from the server, otherwise a reopened conversation would differ from one that was
never left.

**The reply is a stream, and the transcript is blocks.** A stream is a delta; a
transcript is a `ContentBlock[]`. Until C9 nothing folded one into the other — every
renderer wrote frames as deltas arrived and kept no copy.

## Decision

**One call core serves two front doors; the renderer is the seam; a busy pool is an
exception, not null; and the reply is folded back into blocks when the stream ends.**

### 1. `providers/model-call.ts` — one way to call one model

What is extracted from `dispatcher.ts` is the sequence identical for anyone who asks for
it:

```
degrade → compress → phase-2 filter → encode → lease → url + auth → call → decode
```

The first four steps are one function (`outboundRequest`) rather than four calls in two
places, because **the order is an invariant, not a preference**: the pipeline must see
the body that will actually be sent (so the model boundary is applied first), and the
phase-2 rules exist precisely to catch what the pipeline produces (so they run after).
Splitting it across two doors is how that order silently drifts.

What is **not** there is everything that decides _what_ is sent: ingesting the client
body, the phase-1 filter, resolving a name into candidates, and the API key scope check.
All of those read the request, so they belong to the front door that knows what the
request means — and the phase-1 filter must run before routing because ranking reads the
controls the request carries.

**The alternative — two call implementations — is rejected** because the two would drift
on the first change, and the drift would take the form "the console sends different
parameters from `/v1` for the same model": a bug invisible until someone compares two
requests.

### 2. The renderer is the seam

`CallRenderers` is two functions: one for a whole answer, one for a stream. `/v1` passes
`renderResult` and `createStreamRenderer`; the console passes the AI SDK protocol. The
call core never knows which dialect it is speaking, and no renderer knows a pool exists.

**`render` is optional, and null already has a meaning in use.** `callProvider` uses
`null` for "the provider's own bytes are the answer" (the `direct` path, ADR-0019). So a
caller that cannot render a whole answer must not be answered with null; it throws. The
console is that caller — its protocol has no non-streaming form.

**`direct` stays the caller's.** The console is always `false`: there is no "provider's
own bytes" in the UI Message protocol, every answer is re-rendered.

### 3. A busy pool is `NoAccountError`, not `null`

The dispatcher wants to try the next candidate when a provider has no free account; the
console has no next candidate. Returning `null` would make "busy" and "this candidate
cannot serve you" the same value at the boundary, when the two callers need them
separate.

So the call core throws, and:

- `dispatcher.ts` catches it and returns `null` — for a combo, "all accounts busy" and
  "the wire cannot be translated" are indeed the same decision: nothing was sent, try the
  next entry.
- `chat/turn.ts` catches it and becomes `AppError.unavailable` — a 503, because nothing
  is broken and the same turn may succeed shortly.

### 4. The protocol tail is written by the pump, not by the caller

`StreamRenderer` gets an optional `finish?(): string`. The AI SDK protocol closes with a
`finish` frame (carrying metadata this process measured) then a `[DONE]` sentinel that
its reader stops at. Neither belongs to the provider, and both must arrive **before** the
`finished` handler reports and before the stream closes: a consumer released by `close()`
must not race code that reads what the handler recorded.

Four OpenAI surfaces do not implement it — for them the provider's own `finish` is already
the last word.

**Metadata is frozen when `finish()` is called.** The `finish` frame and the transcript
must name the same numbers; recomputing when `metadata()` is called would produce two
different totals for one turn.

**An `error` frame sets `finishReason` to `error` when the provider has not said
anything.** Reporting `stop` would tell the console the model finished on its own — a
reading that makes a truncated answer look whole. A reason the provider already gave
stands: a failure later in the stream is a transport disruption, not a second opinion
about the model.

### 5. The reply is folded back into blocks

`chat/reply.ts` accumulates canonical events into `ContentBlock[]`, following the
`block_start` / delta / `block_stop` triple — so a turn that interleaves thinking, text,
and a tool call comes back in the order the model produced it, which a flat delta cannot
express.

- Tool-call arguments arrive as JSON fragments and are stored as objects; ones that never
  parse are stored with an empty object, not discarded — the tool ran, and a transcript
  with a hole is worse than one with empty arguments.
- A block the provider never closed is still closed here: a stream that dies mid-sentence
  leaves half a sentence on the screen, and that half is what the operator reads.
- `thinking` blocks are stored **without a signature**: the signature is the provider's
  handle for replaying its own reasoning turn, and a conversation continued in the console
  is sent to whatever model the operator picks next.

### 6. An empty reply is not stored; a half reply is

Two sides of the same rule, and the boundary is what the operator sees:

- the provider fails **before the first token** → nothing appears on screen, so there is
  nothing to remember. Only the operator's message is stored. (Storing an empty turn also
  means sending it back to the model on the next request.)
- the provider fails **after the first token** → that half answer was read by the
  operator, and is stored with `finishReason: 'error'`.

### 7. Attachments are a separate field, folded when building the request

The transcript stores `content` (the blocks sent/generated) and `attachments` (the
dropped blobs) separately, because the two are two views of one turn: `attachments` is
what the console renders as a chip beside the message, `content` is what the model reads.
Folding them at store time would make the transcript a record of the _request_, not of the
conversation.

The size boundary is **the same number as the console's** (images 4 MB after scaling, text
256 KB), but **measured from the bytes that arrived**, not from the `byteSize` the client
claims. Two different ceilings would mean a turn the console accepts and the server
rejects — read as a bug, not as a policy. Text is **rejected, not truncated**: a silently
shortened log produces a confident answer about the wrong thing.

Attachment validation runs **before** the turn is stored. A turn whose provider could
never be sent to is not a turn, and learning that after it is in the transcript would make
that session permanently unable to answer — every subsequent turn builds its request from
the same attachments.

### 8. Thinking level is translated per family, and `auto` sends nothing

The console offers one scale (auto/low/medium/high/xhigh/max); four wire families spell
reasoning three different ways, none with six levels. The translation lives in
`chat/thinking.ts` — not in the codec, because the codec renders the _pivot_, and the
pivot has no reasoning column at all.

The values travel via `extras`, which every codec spreads verbatim into its body. That is
also what makes **a model that cannot think never see it**: `demandsOf` reads `extras`, so
the same `degrade` that drops images for a blind model also drops the effort for a model
without the `reasoning` flag — instead of sending a parameter the provider would answer
with a 400.

Two families get nothing, for reasons rather than oversight:

- **Google** wants `generationConfig.thinkingConfig`, and `extras` is spread at the top
  level — a key set here would be overwritten by the codec's `generationConfig`, which is
  assigned after the spread. Fixing it is a change to the manifest schema (ADR-0018), not
  a hack in this function.
- **`custom`** has no codec, so there is no body to put the key in.

`auto` sends anything to anywhere: it means "up to the model", and inventing a level for it
would answer a question deliberately left open.

### 9. Export is its own path, and a title cannot name a path

`GET /chat/sessions/:id/export` — four segments, so the literal `export` cannot be read as
a session id. Its own path rather than a query on the session, because what it returns is
not the session: it is a rendering of that session, with a content type and filename the
browser acts on.

The title is slugged to letters, digits, and hyphens. A title is text the operator types,
and the `content-disposition` header must not be corruptible by it.

### 10. The mock domain `chat` is split from `tools`

`live-domains.ts` splits mocks per _domain_, and a domain has so far meant a nav section.
Tools has four pages with four different backends, and this one lands in C9. Merging them
would flip Studio, Benchmark, and Verification together — precisely the half-migrated
application that switch exists to avoid.

## Consequences

**Positive**

- One call implementation for two doors; a change to the Token Saver, auth, or filter order
  applies to both at once.
- The console can be used without an API key, and still goes through the same pipeline —
  including the operator's own content-filter rules.
- The transcript is a record of the conversation, not of the request: a reopened message is
  identical to one that was never left.
- The stream protocol is tested against real frames through real `/console/api`, not only
  through a mock.
- A half-failed reply is still findable by the operator, with the correct reason.

**Negative / risks**

- **Attachments are stored inline as base64.** The contract carries images as base64 and
  the read model returns the same shape, so the transcript can be rendered without a second
  request — but a chat with many images is a large row. That is the price of a self-contained
  transcript.
- **`metadata()` freezes the numbers when `finish()` is called.** A caller that reads
  metadata before the tail is written gets the snapshot as of then, which may not be what
  was finally sent. The console reads afterwards.
- **Google cannot be asked for reasoning at all.** A Google model that declares `reasoning`
  will be degraded, and the operator sees `x-rutekit-degraded` with no way to fix it until
  the manifest has a way to declare its spelling.
- **A reply the operator cancelled is still stored** if the provider had already sent
  something before the abort. What is stored is what the operator read; distinguishing
  "cancelled" from "failed" needs a signal that does not exist yet.
- **No server-side branching.** `parentMessageId` is stored, but `truncateFrom` is not used
  by any route yet — FR-7.8 is done on the console side by cutting the local transcript.
- **No tool loop.** A tool call is stored and displayed, but rutekit never runs the tool and
  sends its result back.
- **Chat cost does not enter any API key's budget.** The console uses no key, so the only
  place this turn appears is the `requests` table — there is no per-session aggregation yet.

## Rejected alternatives

| Alternative                                                       | Reason for rejection                                                                               |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Two call implementations (one per door)                           | Drifts on the first change; the bug is invisible until two requests are compared                   |
| The client sending the whole transcript every turn                | A reopened conversation differs from one never left; the body grows without bound                  |
| Busy pool → `null` from the call core                             | "Busy" and "cannot serve" become the same value, when the two callers need them separate           |
| The call core picking a renderer from a flag                      | The call core would know the dialect; the renderer would know the pool                             |
| `finish`/`[DONE]` written by the caller after `callModel` returns | The `finished` handler has already reported and the body is already closed; the last frame is lost |
| Metadata recomputed in `metadata()`                               | The `finish` frame and the transcript name different totals for one turn                           |
| Storing an empty reply                                            | Renders as an empty turn, and is sent back to the model on the next turn                           |
| Discarding a half reply                                           | That half answer was read by the operator; discarding it makes the transcript lie                  |
| Attachments folded into `content` at store time                   | The transcript becomes a record of the request, not the conversation; the UI chip loses its source |
| Attachment limit from the client's `byteSize`                     | The client is the party the limit exists to bound                                                  |
| Large text truncated instead of rejected                          | A silently shortened log produces a confident answer about the wrong thing                         |
| Reasoning hardcoded in the codec                                  | The codec renders the pivot, and the pivot has no reasoning column                                 |
| Google given `thinkingConfig` via `extras`                        | Overwritten by the codec's `generationConfig`, which is assigned after the spread                  |
| Export as a `?format=markdown` query                              | What is returned is not the session, and the browser needs a content type + filename               |
| Chat merged into the `tools` mock domain                          | Flips three other pages whose backends do not exist yet                                            |
