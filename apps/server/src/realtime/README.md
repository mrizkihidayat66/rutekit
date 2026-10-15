# `realtime`

The one WebSocket that carries every live view: jobs, accounts, Studio renders, the
console log (ADR-0012).

## What it owns

Fan-out. One socket per client, many channels on it; a page subscribes to the channels it
is showing and unsubscribes on unmount, so an idle tab costs nothing. The hub is
deliberately ignorant of _what_ it carries — it routes by channel and stamps ordering, and
the domain modules (jobs, studio) register listeners for the client messages they care
about.

## The files that matter

- **`hub.ts`** — `RealtimeHub`: `open`/`close`, `handleRaw`, `publish`, `onClientMessage`,
  `sweep`, `closeAll`. Parses inbound frames, answers `ping`/`subscribe`/`unsubscribe`
  itself, and hands the domain messages to listeners.
- **`connection.ts`** — `HubConnection`: one client's channel set, last-seen, and the
  per-connection monotonic `seq` stamped on every frame.

## Invariants and traps

- **The hub routes; it does not understand.** `ack`/`job_control`/`manual_input`/
  `studio_cancel` are forwarded to listeners. They are listed explicitly rather than left
  to a `default`, so a channel added to the contract's union is a compile error here.
- **The connection id is minted before the upgrade is answered**, in `app.ts`'s `wsRoute`,
  so the `hello` the hub sends on open already carries it and every later frame from that
  peer is keyed by the same id.
- **`seq` is per connection and monotonic.** It is the client's ordering and gap signal;
  do not reuse or reset it.
- **A parse failure answers with the same error envelope the HTTP side uses**
  (`AppError.toApiError`), so a client has one error shape to handle (R5.9).
- **The socket is held behind a two-method `HubSocket` interface**, so a test can hand in a
  recorder and assert the frames a client would have received without standing up a server.
- **`closeAll` runs on drain**, before `server.stop()`, because WebSocket clients are
  exactly the connections that never close on their own (see `runtime/shutdown.ts`).
- **`sweep()` drops connections after missed heartbeats**; it is driven by a timer in
  `main.ts`, not by the hub itself.
