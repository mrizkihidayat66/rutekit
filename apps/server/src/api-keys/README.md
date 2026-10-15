# `api-keys`

Issuing, listing and ceasing API keys — the bearer credentials that open the `/v1`
data plane (FR-6).

## What it owns

The lifecycle of a key as a _record_: minting the secret, storing only its hash,
applying an update, revoking, deleting, and answering the two lookups the guards and
the dispatcher need. It also owns the two per-key ceilings (tokens per second,
requests per minute) that are counted in memory. It does **not** own authentication
itself — that is `ingress/api-key-guard.ts`, which reads this service.

## The files that matter

- **`service.ts`** — `ApiKeyService`. `create` mints via `security/tokens.ts` and is
  the one place the plaintext secret appears in a response. `findBySecret` hashes the
  presented value and looks up the row; `findById` exists because the guard puts only
  an id on the context and the dispatcher needs the row's scope lists.
- **`limits.ts`** — `KeyRateLimiter`: fixed-window counters for TPS and RPM, held in
  a `Map` with an idle sweep.

## Invariants and traps

- **The secret is shown exactly once.** `create` returns `{ apiKey, secret }`; the
  row stores `secretHash` (SHA-256) and a display `prefix`. There is no read path that
  reconstructs a key.
- **Lifecycle state is derived, never stored.** Both `list` and the guard call
  `deriveApiKeyState` from `@contracts` on the row, so a key the console paints
  "expired" is refused as expired by the same rule at the same instant. Do not add a
  `state` column.
- **`listAll` returns everything, unordered.** The service filters, sorts and pages
  in memory because a key's state is derived — a `where` clause could not express it
  and reimplementing the derivation in SQL would be a second source of truth.
- **Usage counters increment in SQL**, never read-modify-write: two concurrent
  requests on one key are the case this table exists for.
- **The rate limiter is in memory and fixed-window.** A refusal does **not** consume a
  slot. Counters do not survive a restart — that is correct for a per-process ceiling.
  The _budget_ ceilings (`budgetRequests`, `budgetTokens`) are different and live in
  the row, because those must survive a restart.
- A key with neither ceiling set short-circuits to `ALLOWED`; do not add per-request
  bookkeeping there.
