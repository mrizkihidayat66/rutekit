# `ingress`

The middleware pipeline every request passes through before a route sees it: identity,
abuse counting, body policy, readiness, and the two doors.

## What it owns

Cross-cutting request handling that no single route should own — minting a request id,
deriving a client address safely, refusing oversized or mislabelled bodies, refusing work
the instance cannot finish, authenticating the two namespaces, and turning any failure
into the right error envelope. The order these run in is set in `app.ts`, not here, but
this folder is where each stage's rule lives.

## The files that matter

- **`request-context.ts`** — sets `requestId`, `startedAtMs`, `clientIp`. Runs first.
- **`client-ip.ts`** — `deriveClientIp`. `X-Forwarded-For` is honoured **only** when the
  socket peer is loopback; otherwise it is ignored rather than believed (A24).
- **`abuse.ts`** — `AbuseGuard` + the `*` middleware. Per-address fixed window, mounted on
  `*` so a flood of 404s is counted too (CONTRIBUTING §5.2).
- **`body-policy.ts`** — refuses from `Content-Length` before the body is materialised;
  content-type check for present-but-mislabelled bodies.
- **`readiness.ts`** — `readinessGate`: 503 + `retry-after` while draining, mounted on the
  two namespaces and **not** on the probes.
- **`api-key-guard.ts`** — the `/v1` door: bearer secret → row → derived state → the key's
  two ceilings.
- **`error-lifecycle.ts`** — the single `onError`/`notFound` that renders one of two
  dialects depending on whether the path is `/v1`.
- **`validate.ts`** — `jsonBody(schema)`: turns a Zod failure into an `AppError` so the
  client gets the console's envelope, not the validator's own JSON.

## Invariants and traps

- **Stage order is load-bearing (R5.3).** `requestContext` → `abuseGuard` → `bodyPolicy`,
  then `readinessGate`, then the two guards. Do not reorder without an ADR; see the
  comment block in `app.ts` for what each position buys.
- **The abuse guard fails open (R5.5).** A broken counter is degraded protection, not a
  reason to refuse every request. The two probes (`/healthz`, `/readyz`) are exempt, or a
  throttled `/readyz` would read as "not ready".
- **The readiness gate must never be mounted on the probes.** They exist to report the
  state it enforces (A23).
- **The two error dialects are chosen by path, not by the handler that raised.** Failures
  reach `errorLifecycle` from stages no router sees (the guard, the readiness gate), and
  each must answer in the dialect of the namespace it was addressed to.
- **Never return a stack trace or a raw driver message** (R5.9). The cause is logged
  keyed by `requestId`; the client gets the message only.
- **The API-key guard refuses with a kind that says why** — bad secret `authentication`,
  spent budget `quota_exhausted`, a ceiling `rate_limit` with `retry-after`.
