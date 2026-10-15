# ADR-0008 — Auth v1: single-user + password

Status: **Accepted** · Date: 2026-10-11 · Related decisions: D8

## Context

A feature-rich auth stack — JWT sessions, bcrypt, SAML SSO, and OIDC — also adds a large
security surface and complexity. Simpler implementations in this space use a single
password, or a setup wizard plus login and route guards. `rutekit` v1 targets self-host
by a single user or a single installation.

## Decision

**Single-user with a password** → session cookie. Hashing with **Argon2id**.
One account, created during the first-run wizard (`/setup`).

API keys remain as a programmatic access path to `/v1/*` endpoints, with full control
(quota, models allowed, expiry, TPS, rate limit, scope).

## Consequences

**Positive**

- Small attack surface, easy to audit.
- No user, role, or RBAC tables to build and test in v1.
- User setup: one password.
- API keys can still carry full scope — control stays granular for programmatic traffic.

**Negative / risks**

- No access sharing between humans with different permissions.
- No per-user audit trail.

## Upgrade path

| Version | Addition                                                                      |
| ------- | ----------------------------------------------------------------------------- |
| v1      | Password → session cookie                                                     |
| v2      | Multi-user + roles (`admin` / `operator` / `viewer`) + per-user API key scope |
| v3      | Optional OIDC/SSO                                                             |

The DB schema is designed from the start with a `created_by` column on the relevant
entities so that migrating to multi-user requires no restructuring.

## Rejected alternatives

| Alternative               | Reason for rejection                                            |
| ------------------------- | --------------------------------------------------------------- |
| Multi-user from the start | Significant complexity in the early phase; no user asked for it |
| No auth (localhost-only)  | Unsafe if exposed via a tunnel — weakens the threat model       |
| SAML/SSO in v1            | Enterprise complexity without an enterprise audience (R15)      |
