# ADR-0018 — The provider manifest as the single declarative source of truth

Status: **Accepted** · Date: 2026-10-13 · Related decisions: D6

## Context

ADR-0006 decided that v1 supports ~30 curated providers, and its mitigation reads
"adding a provider is only one file + one index entry". That is only possible if the
shape of the provider file is fixed first, because that file is what almost every later
backend group will read:

- **C4 (Translator)** needs to know the wire dialect (`wireFamily`) and the chat path of
  each provider in order to choose a pivot.
- **C5 (Pool & Routing)** needs to know which error rules mean "this account is used up"
  and which mean "try again" — that classification determines the transitions of the
  7-state state machine.
- **C6 (Quota & Usage)** needs to know where quota is read from (header vs endpoint) and
  how long the window is.
- **C7 (Automation)** needs to know which providers have an automation flow at all.

If each group defines its own piece of this knowledge, ~30 providers means
~30 places that can disagree. Conversely, one file per provider that carries all of it
makes "provider X is not supported yet" always have a concrete answer: the file does not
exist yet, or one of its fields is still empty.

## Decision

**One declarative manifest per provider is the single source of truth about that
provider**, and the manifest is **inert data**.

The locked shape:

1. **One file per provider** in `packages/provider-registry/src/providers/`, one
   entry in a **generated** `index.ts` (AP-6). A stale index fails the test,
   so there is no way to "forget to add a provider".
2. **The manifest carries all provider knowledge**: identity, endpoints, auth mode,
   capabilities, discovery, curated models, quota, error rules, automation. Fields
   that do not yet apply are answered explicitly (`quota.kind: 'none'` + `reason`), not
   left empty — so "not done yet" cannot hide as an empty field.
3. **The registry validates at build time**: the zod schema checks one field,
   `invariants.ts` checks fields against one another, and `registry.ts` refuses to build
   a contradictory catalog. Contradictions are caught in tests, not at runtime.
4. **The package is server-only and performs no I/O.** `discovery.ts` takes
   `fetch` as an argument (`Fetcher`) rather than grabbing the global; the request/response
   types are structural, and `tsconfig` declares `types: []`. That is what makes it testable
   without a socket, and what makes it safe to grow to carry OAuth without ever being
   bundled into the console.
5. **The console learns about providers through the API + `@contracts`, not by
   importing the registry.** The FE/BE boundary is enforced by tests.
6. **Error classification is data on the manifest**, evaluated in order,
   **first-match-wins**. A 429 with no body = rate limit; a 429 with `insufficient_quota`
   = quota exhausted — two things the pool must handle differently.
7. **URLs are assembled from the manifest**: a literal `baseUrl`, or a `baseUrlTemplate`
   with per-account placeholders (Vertex needs `{region}` and `{project}`). Unfilled
   placeholders are all collected **at once**, rather than failing on the first one.
8. **`discovery.strategy` recognizes `static` as a real strategy.** A
   provider may have no listing endpoint at all (a local runner); the curated list is the
   only list, and `source` says so.
9. **A model's `source` is `template | synced | custom`.** An id synced
   from an endpoint **retains** the capabilities and prices curated in the manifest;
   only genuinely foreign ids arrive with nothing but their name.

## Consequences

**Positive**

- Adding a provider = one file + regenerating the index; the ADR-0006 checklist has a
  concrete home.
- C4–C7 read one shape, not seven.
- The whole package can be tested without a network or a runtime host.
- The console never receives an endpoint, an auth flow, or an upstream response shape —
  only a read model from the API.

**Negative / risks**

- Every backend group now **must** read the manifest, so a change to the manifest
  shape touches many callers at once.
- The manifest can bloat into de facto configuration; the discipline "fields that do not yet
  apply are answered explicitly" holds this back, but it still needs watching as C3b
  adds ~25 providers.
- Curated models and synced results can differ (the endpoint adds new ids), so the
  UI must show `source` so that difference is legible rather than surprising.

## Rejected alternatives

| Alternative                                                                       | Reason for rejection                                                                                                  |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Provider knowledge spread across per-group code                                   | ~30 providers × N groups = N places that can disagree; this is the weakness of that approach                          |
| The manifest as runtime configuration (a DB/JSON the user can edit)               | Loses build-time validation and derived types; providers become data that can rot unnoticed                           |
| The registry importing the global `fetch` and living in a package shared by FE/BE | The package can no longer be tested without a runtime, and provider endpoints/auth flows leak into the console bundle |
| One large file containing all providers                                           | Removes the "one provider, one file" property that keeps diffs and reviews small                                      |
