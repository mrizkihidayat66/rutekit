# `translator`

The pivot: one canonical shape every client surface is ingested into and every
provider dialect is rendered out of, with a `direct` route for the pairs that
cannot survive it (FR-1.2, ADR-0019).

## What it owns

The canonical request, result and stream vocabulary; the ingest function for each
client surface; the surface renderers plus the AI SDK's UI Message stream; and the
wire codecs for the `openai`, `anthropic` and `google` families. It performs no I/O:
a codec is handed bytes or a parsed body and returns a value, and the server owns the
socket, which is what keeps the pivot exercisable without a runtime.

## The files that matter

- **`route.ts`** — `chooseRoute`: the one place that decides `direct` vs `pivot`,
  and it decides the **answer** direction, never the request.
- **`surface.ts`** — the `ClientSurface` names, spelled the way the paths are.
- **`canonical-request.ts`** — the pivot request: `system` hoisted out of `messages`,
  sampling nullable rather than optional, `extras` for everything the pivot drops.
- **`canonical-result.ts`** and **`canonical-stream.ts`** — one assistant turn, and
  the event vocabulary a stream is decoded into and re-rendered from.
- **`blocks.ts`** — the narrowing helpers ingest shares (`asRecord`, `imageBlockOf`,
  `parseToolArguments`); each returns null rather than throwing.
- **`ingest/`** — one file per surface; each validates the client body and pivots it.
- **`render/`** — one file per surface, plus `ui-message.ts` for the chat console.
- **`codecs/`** — one file per wire family, its stream decoder, and `blocks.ts`, the
  builder that synthesises block boundaries from flat deltas.

## Invariants and traps

- **The request always pivots; only the answer may not.** Token Saver works on the
  canonical request, so a body forwarded verbatim is a body rutekit cannot compress.
  `chooseRoute` is called every turn and its verdict is ignored for the request.
- **A `direct` pair is direct because of a field the pivot cannot carry.** A Claude
  thinking block's `signature` arrives in a `signature_delta` the pivot has no event
  for, and replay needs it byte for byte; an openai client to an openai provider
  sends fields the pivot has never heard of. Re-rendering either drops them silently.
- **A pair is not a family.** `messages` to an `openai` provider is not direct even
  though the family is known, because the surface differs from it; `/v1/responses`
  and `/v1/completions` are not the chat shape, so they pivot regardless.
- **Ingest, codec and render are three dialects, not one pipeline.** Ingest reads the
  client's, a codec reads and writes the provider's, render writes the client's. That
  is what makes N surfaces and M families cost N + M modules, not N × M.
- **Every codec spreads `extras` first, then writes the fields it models**, so a
  parameter rutekit has not learned still reaches a provider that understands it, and
  the pivot wins for anything it does know.
- **`custom` has no codec, deliberately.** `codecFor` returns null rather than
  falling back to `openai`: a wire rutekit does not know cannot be reached through
  `/v1`, only probed.
- **Blocks are synthesised where the provider has none.** `openai` and `google`
  stream a turn as flat text and report tool calls by position, so the builder
  invents the boundaries; `anthropic` streams the block triple itself.
- **A codec holds the finish until the stream ends.** Finish reason and usage arrive
  in separate frames, so the decoder buffers them and emits `finish` from `flush`; a
  renderer never sees a turn whose usage is not there yet.
- **The matrix test names no pair.** It sweeps `clientSurfaceSchema.options` ×
  `wireFamilySchema.options` through ingest, route, encode, decode and render, then
  asserts each rendered body parses against the surface's own contract schema. A
  family added to the enum is covered the moment it exists, and a missing codec or
  fixture is a type error, because the fixture records are exhaustive over the enum.
