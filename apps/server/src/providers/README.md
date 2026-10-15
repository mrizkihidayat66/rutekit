# `providers`

The provider layer: the catalogue read models, the one call rutekit makes to a model, and
the sign-in flows that fill the account pool (C3/C4/C13a, ADR-0018/0019/0022).

## What it owns

Turning a resolved model into an actual upstream call — the lease, the Token Saver, the
encoding, the socket, the stream — and the surrounding read/write surfaces: the Providers
console's catalog and service, model discovery, OAuth sign-in, and the egress-checked
outbound fetchers. This is the only place that speaks a provider's wire.

## The files that matter

- **`model-call.ts`** — `callModel`: the core that both `/v1` and the chat console use. It
  owns the one span that must not diverge — degrade → compress → phase-2 filters → encode.
- **`dispatcher.ts`** — the `/v1` front door: what a name means, whether the key may use
  it, and the combo walk.
- **`provider-call.ts`** + **`stream-pump.ts`** — the single upstream call and the SSE pump.
- **`outbound.ts`** — `createOutboundFetcher` / `createOutboundResponseFetcher`, both behind
  the egress guard. **Every** outbound call in the server goes through here.
- **`dispatch-errors.ts`** — provider refusal → `AppError`, and the `/v1` error envelope.
- **`model-catalog.ts`** — model id → provider/wire. **`credential.ts`** — the read half of
  the encrypted envelope. **`stored-manifests.ts`** — a BYOK row → a manifest.
- **`provider-catalog.ts`** / **`provider-service.ts`** — the Providers console's read and
  write sides.
- **`oauth/`** — the sign-in flows: `service.ts` (the console's entry), `browser.ts`,
  `device.ts` + `device-session.ts`, `flow.ts`, `wire.ts`, `pending.ts`, `pkce.ts`,
  `identity.ts`, `resolve.ts`, `store.ts`.

## Invariants and traps

- **The request always pivots (ADR-0019).** `chooseRoute` is consulted, but it decides the
  _answer_ direction, not the question — because the Token Saver works on the canonical
  request, and a verbatim-forwarded body is a body rutekit cannot compress.
- **The outbound order in `model-call.ts` is an invariant, not a preference**: degrade for
  the chosen model → compress → phase-2 filters → encode. Splitting these across the two
  front doors is how the order would quietly diverge.
- **A combo walks its chain only until the answer is committed.** A step that fails _before_
  its headers may be retried on the next candidate; a step that already produced a 200 with
  a body may not. `callProvider` returning is the boundary.
- **A busy pool is an exception (`NoAccountError`), not a null.** The dispatcher catches it
  to try the next candidate; the chat console has no next candidate and lets it become a
  message.
- **Streaming: prime the first chunk before committing the 200.** After the body starts, a
  failure can only be reported in the stream's own dialect (or by aborting, on the direct
  route).
- **Capability degradation is reported, never silent**: dropped controls go on the
  `x-rutekit-degraded` header, never in the SSE body.
- **The credential goes in a header, never a URL**, and `readCredential` returns null for a
  tampered/undecryptable envelope rather than sending junk upstream.
- **A BYOK provider's credential is an account**, not a provider column — one endpoint,
  many credentials, so it is revocable and quota-tracked like any other.
- **`requireSecrets` throws when no encryption key is set**, which makes credential storage
  unavailable rather than silently plaintext.
