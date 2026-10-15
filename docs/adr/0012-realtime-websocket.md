# ADR-0012 — Real-time: WebSocket for everything

Status: **Accepted** · Date: 2026-10-11 · Related decisions: D12

## Context

The dashboard needs real-time streams for several kinds of data with different
characteristics:

| Need                                                  | Direction       | Frequency                                        |
| ----------------------------------------------------- | --------------- | ------------------------------------------------ |
| Server console log                                    | server → client | high, continuous                                 |
| Account status & health                               | server → client | medium                                           |
| **Screenshot automation**                             | server → client | high (default every 2s per worker, many workers) |
| Job progress (import, studio, benchmark)              | server → client | medium                                           |
| Automation control (cancel, manual-open, stop worker) | client → server | low, but **bidirectional**                       |
| Notifications                                         | server → client | low                                              |

Screenshot automation alone already produces a large volume of frames; this is a
high-frequency binary stream.

## Decision

**One WebSocket connection** for all real-time needs. No SSE.

The WebSocket is mounted at the path `/ws` (Hono `upgradeWebSocket`), with
multiplexing by channel:

```
/ws
├── channel: log          (console log, request log)
├── channel: accounts     (status, health, cooldown)
├── channel: jobs         (job progress: import, studio, benchmark)
├── channel: preview      (screenshot automation)
└── channel: notifications
```

The client sends `{ type: 'subscribe', channel }` / `{ type: 'unsubscribe', channel }`.
The server sends `{ channel, type, payload }`.

## Consequences

**Positive**

- One transport to maintain: one connection, one reconnect strategy, one auth scheme.
- Supports bidirectional communication — automation control (cancel, manual-open) needs no
  separate HTTP endpoint, so it stays consistent.
- Efficient for high-frequency screenshots (base64 frames) — no per-frame
  connection-opening overhead as with repeated SSE.
- Corroborated by comparable implementations: WebSocket is what is used for
  screenshot and console-log streams.

**Negative / risks**

- Reconnect & backoff must be implemented yourself (mitigated: one `use-socket` hook
  in the frontend, one hub in the backend).
- Certain proxies/CDNs close idle WS connections → a heartbeat ping/pong is needed.
- No built-in resume like SSE `Last-Event-ID` → a sequence number per log channel is
  needed so the client can detect gaps and request a backfill over HTTP.

## Mitigation

| Risk                   | Mitigation                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| Reconnect              | `use-socket` hook with exponential backoff + a status indicator in the UI                    |
| Idle connection closed | Heartbeat `{ type: 'ping' }` every 30s                                                       |
| Gap on reconnect       | A sequence number per channel; the client detects the jump and requests a backfill over REST |

## Rejected alternatives

| Alternative                       | Reason for rejection                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| SSE for logs + WS for interactive | Two transports to maintain; no real advantage since WS already handles both        |
| SSE only + polling                | Cannot handle bidirectional control well; polling is more wasteful for screenshots |
| Socket.IO                         | Excess weight; native WS is enough                                                 |

## Note on inference streaming

The WebSocket in this ADR is for **dashboard telemetry**. Streaming model response tokens
to an AI client (OpenAI-compatible clients) stays **SSE** — that is part of the `/v1/*`
protocol contract, not part of the dashboard UI. The two coexist and do not
replace each other.
