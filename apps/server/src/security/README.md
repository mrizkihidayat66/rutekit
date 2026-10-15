# `security`

The primitives the rest of the server builds its controls out of: egress, address
classification, password hashing, credential encryption, and token minting.

## What it owns

Five pure-ish primitives with no policy of their own beyond the one each implements. None
of them knows about a route or a table; they are the mechanisms the guards, the pool and
the persistence layer call. Keeping them here is what lets the SSRF control, the password
rule and the credential envelope each be tested without a socket, a request or a database.

## The files that matter

- **`egress.ts`** — `EgressPolicy`: `checkUrl` (creation time) and `checkAddress` (connect
  time). The two moments catch different attacks.
- **`ip-address.ts`** — pure address parsing and classification: `parseAddress`,
  `isBlockedAddress`, `parseCidr`, `cidrContains`. Everything is arithmetic over a
  `bigint`, so it is testable without a socket.
- **`secret-box.ts`** — `SecretBox`: AES-256-GCM envelope encryption for provider
  credentials, with a self-describing `v1:<iv>:<tag>:<ciphertext>` string.
- **`password.ts`** — Argon2id via Bun, with `RUTEKIT_AUTH_SECRET` applied as a pepper.
- **`tokens.ts`** — `mintApiKey`, `mintSessionToken`, `hashToken`. The stored form of every
  opaque secret.

## Invariants and traps

- **Egress is checked at creation _and_ at connect, and the two are different checks.** At
  creation the host may be a hostname and passes; the connect-time check is what a DNS
  rebind cannot slip past. `providers/outbound.ts` is the only caller — nothing may reach
  the network without going through it.
- **A malformed allowlist entry throws at construction.** A typo in a security allowlist
  must be loud, not silently ignored.
- **The address check is on the address, never the hostname** — a name that resolves to
  `127.0.0.1` is refused even when it reads public. `isBlockedAddress` returns `false` for
  a non-address (it is a classification, not a validation); the caller decides what an
  unparseable host means.
- **A `SecretBox` envelope is authenticated.** `decrypt` throws on a tampered, truncated or
  foreign envelope — it never returns plausible garbage. The fixed scrypt salt is domain
  separation, not stretching (the input key is already 256 bits of entropy).
- **`SecretBox` needs a 32-byte key** and throws otherwise; a null box (no
  `RUTEKIT_ENCRYPTION_KEY`) makes credential storage _unavailable_, never plaintext.
- **The password is Argon2id with an optional pepper; minted tokens are plain SHA-256.**
  This asymmetry is deliberate: a password is short and worth slowing a guesser down for; a
  minted token is 256 random bits where a slow hash would buy nothing and cost a hash on
  every request. Do not "fix" one to match the other.
- **Changing `RUTEKIT_AUTH_SECRET` after first run makes the existing password
  unverifiable** — the correct outcome for a secret that is supposed to be fixed.
