# ADR-0009 — Automation: separate Node subprocess for Playwright

Status: **Accepted** · Date: 2026-10-11 · Related decisions: D9, D1

## Context

Automation for login/account import requires a real browser with full control
(Playwright, and optionally Camoufox as a stealth engine). ADR-0001 chose Bun as the
runtime, but **Playwright officially supports Node, not Bun**. One workaround seen in
this space is Python + Playwright, which creates two runtimes (rejected as R5). Another
is to run the automation directly on Node.

Additional needs: **live browser preview** (streaming screenshots to the dashboard),
**captcha detection + manual input until timeout**, and **retry on failure**.

## Decision

Automation runs in a **separate Node subprocess** (`tools/automation-worker/`),
launched by the Bun backend, communicating over **stdio JSON-lines**.

```
apps/server (Bun)  ──stdio JSON-lines──▶  tools/automation-worker (Node + Playwright)
      │                                              │
      └────────── WebSocket ──▶ dashboard ◀──────────┘
                                (screenshot, progress)
```

## stdio protocol

| Direction     | Message                                                                                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| host → worker | `{ type: 'start', job }`, `{ type: 'cancel', workerId }`, `{ type: 'manual-open', workerId }`                                                                                                                                    |
| worker → host | `{ type: 'step', workerId, step, message }`, `{ type: 'screenshot', workerId, jpegBase64 }`, `{ type: 'needs-manual', workerId, error }`, `{ type: 'done', workerId, result }`, `{ type: 'failed', workerId, error, retryable }` |

Every message is validated at runtime on both sides (R1.7).

## Consequences

**Positive**

- Playwright compatibility guaranteed without giving up the Bun choice on the server.
- Crash isolation: a dead worker does not bring down the gateway.
- One language (TypeScript) on both sides — unlike a Python-based worker.
- The worker can be restarted, scaled, or run on a separate machine later.

**Negative / risks**

- Two processes to manage (lifecycle, restart, orphan cleanup).
- A new boundary that must be validated (mitigation: contracts schema + runtime validation).
- A little stdio serialization overhead.

## Rejected alternatives

| Alternative                                    | Reason for rejection                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| Playwright directly on Bun                     | No official support; risk of unexpected behavior                         |
| Python + Playwright                            | Two runtimes, fragile deployment (R5); loses type safety at the boundary |
| Running the browser in the same server process | A browser crash brings down the gateway; no isolation                    |
