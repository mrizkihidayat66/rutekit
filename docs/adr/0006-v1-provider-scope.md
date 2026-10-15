# ADR-0006 — v1 provider scope: ~30 curated providers

Status: **Accepted** · Date: 2026-10-11 · Related decisions: D6

## Context

Comparable routers in this space support anywhere from a dozen to over a hundred
providers. A declarative registry makes adding a provider cheap mechanically, but **every
provider still requires verification**: auth shape, model mapping, protocol quirks,
error handling, and a quota checker. A provider added without verification produces a
poor experience and a support burden.

## Decision

v1 targets **~30 curated providers**, chosen because they are (a) popular, (b) have
automatable setup, or (c) represent different categories (OAuth, API-key, media, search,
local, BYOK). Every provider that is included **must** pass:

1. Verified model discovery.
2. Documented model mapping.
3. Classified error handling (rate limit, quota, auth, transient).
4. A working quota checker, **or** a written reason why it does not apply.
5. Covered by the translator test matrix.

## Consequences

**Positive**

- Quality > quantity: every provider actually works.
- Support and test burden stays manageable.
- The first release can be reached much faster.
- Adding a provider later only requires following the checklist above — a clear upgrade path.

**Negative / risks**

- Loses some of the "supports every provider" appeal at the start.
- Raises the question "why isn't provider X there yet" — answered by the checklist.

## Mitigation

The registry is designed so that adding a provider is just one file plus one index entry
(auto-generated). The documentation provides a provider template. The test matrix
automatically covers new providers without changing tests.

## Rejected alternatives

| Alternative                          | Reason for rejection                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| Port all ≥100 providers from day one | Many providers would be broken/untested; repeats the weakness of the prior art         |
| BYOK-only in v1                      | Loses the core value proposition (pool + automation); useful only as an add-on feature |
