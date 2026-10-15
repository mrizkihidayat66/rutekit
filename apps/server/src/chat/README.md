# `chat`

The console chat: conversations, their transcripts, and the streamed turn that answers
one (C9, ADR-0028).

## What it owns

The second front door to `providers/model-call.ts`. `/v1` arrives with a model _name_
and an API key; this arrives with a provider and a model the operator picked and has no
key at all — but everything after the choice is the same call. This folder owns the
conversation store, the fold that turns a stream back into stored blocks, the
attachment fold, and the translation of the console's thinking level into the provider's
own vocabulary.

## The files that matter

- **`turn.ts`** — `createChatTurns().run()`. Reads the transcript, stores the operator's
  turn _before_ calling, calls `callModel`, folds and stores the reply in `onStreamEnd`.
- **`sessions.ts`** — `ChatService`: session CRUD, `transcript`, message append. Reads
  every row back through the contract.
- **`reply.ts`** — `createReplyFold()`: canonical stream events → stored `ContentBlock[]`.
- **`thinking.ts`** — `reasoningAsk(level, family)`: the console's six-rung scale →
  provider `extras`.
- **`attachments.ts`** — attachments → content blocks, with the server's own size caps.

## Invariants and traps

- **The conversation is read from the server's rows, not received from the client.** The
  console sends one turn; the rest of the transcript comes from `chat_messages`. That is
  what makes a resumed chat identical to one that never left the page.
- **The turn is stored before the provider is called**, so a failed turn still leaves
  what the operator wrote.
- **The reply is written in `onStreamEnd`, which the pump calls before it closes the
  body.** A client that reads `[DONE]` and immediately re-fetches must find the reply
  already there. Do not move that write later.
- **A reply that produced nothing is not stored**; a reply that produced a partial answer
  is kept with `finishReason: 'error'`. The console renders the second as a failed turn.
- **The fold follows the block triple** (`block_start`/delta/`block_stop`), not flat
  deltas, so interleaved thinking/text/tool output keeps the model's order. Tool-call
  arguments that never parsed are stored as an empty object, not dropped.
- **Thinking travels in `extras`**, which every codec spreads verbatim. A model whose
  manifest does not claim `reasoning` never sees any of it — `plan/capability.ts`'s
  `degrade` removes it. Google and `custom` are deliberately not supported (see the file
  header for why).
- **Attachment limits are measured from the bytes that arrived**, not the client's
  declared `byteSize`, and a text file is refused rather than truncated.
