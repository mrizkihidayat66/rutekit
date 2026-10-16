# Security Policy

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on the repository's **Security** tab. Do not open a public issue for a vulnerability.

Please include what you did, what happened, and what you expected — a reproduction is worth
more than a severity estimate.

This project currently has no remote configured, so that channel becomes available once the
repository is hosted on GitHub again. Until then there is no working private channel, and
that is stated here rather than papered over.

## Supported versions

The `0.1.x` line is the only one supported. This is pre-1.0 software: there are no
backports, and fixes land on `main`.

## What rutekit is, as a security boundary

rutekit is a **single-user, self-hosted** gateway. That shapes what counts as a
vulnerability:

- **One operator, one password.** There is no multi-tenancy, no user accounts, and no
  privilege separation between administrators. Anything that lets an authenticated operator
  do more than an operator can do is not a privilege escalation, because there is only one
  privilege level.
- **The network boundary is the trust boundary.** The server binds `127.0.0.1` by default.
  Exposing it to a network is a deliberate operator decision, and doing so without TLS or a
  reverse proxy is a deployment choice rather than a vulnerability in rutekit.
- **Provider credentials are the crown jewels.** They are stored encrypted, and anything that
  discloses them or defeats that encryption is in scope and serious.

## How secrets are handled

| Secret                            | At rest                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------- |
| Operator password                 | Argon2id (OWASP baseline: 19 MiB, 2 passes), peppered with `RUTEKIT_AUTH_SECRET` |
| Session and API-key secrets       | SHA-256. Deliberate: they are high-entropy random, so a slow KDF buys nothing    |
| Provider credentials and VCC PANs | AES-256-GCM, key derived from `RUTEKIT_ENCRYPTION_KEY` via scrypt                |

API keys carry a scope, an expiry, a per-second and per-minute ceiling, a budget and a
denylist, all enforced at the `/v1` guard. Outbound requests pass an egress policy that
refuses private and reserved address ranges, which is the SSRF guard.

## Out of scope

- Denial of service through resource exhaustion on a self-hosted instance the reporter
  already controls.
- Anything requiring an attacker to already hold `RUTEKIT_ENCRYPTION_KEY`,
  `RUTEKIT_AUTH_SECRET`, or the operator password.
- Missing hardening headers on an instance that is not exposed to a network.
- Vulnerabilities in third-party providers, or in models reached through the gateway.
- The `VITE_MOCKS=on` development mock layer. It is a development affordance, off by
  default, and it announces itself at boot.

## Hardening a deployment

- Set both secrets. `bun apps/cli/src/index.ts init` generates them — the CLI is not
  published, so it runs from a checkout. An instance that starts without them warns at boot
  and cannot store credentials.
- Keep the bind on loopback unless something in front of it terminates TLS and authenticates.
- Terminate TLS at a reverse proxy if the console is reachable beyond the host, and set
  `RUTEKIT_CONSOLE_ORIGIN` so OAuth redirects return to the right address.
- `.env` holds the key every stored credential is encrypted under. It is gitignored; keep it
  that way, and back it up — losing it makes stored credentials unrecoverable.
