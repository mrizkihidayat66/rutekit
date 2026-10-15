# ADR-0002 — Language: TypeScript end-to-end

Status: **Accepted** · Date: 2026-10-11 · Related decisions: D2

## Context

The most complex domains in this space — cross-protocol translators, binary protocol
parsing (AWS EventStream, protobuf), and mapping data shapes between providers — are
exactly where JavaScript-only codebases become hard to trace. TypeScript-based
implementations of the same work are markedly easier to follow.

## Decision

**TypeScript end-to-end**, full strict mode (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`). JavaScript is forbidden in `apps/`
and `packages/`.

## Consequences

**Positive**

- Translators and binary protocols get type safety at the points most prone to error.
- The frontend/backend boundary can be enforced structurally by types.
- Large refactors (e.g. adding one new protocol surface) become safe.
- Autocomplete and navigation in the editor are far better.

**Negative / risks**

- Build/test time is longer than pure JS.
- Some third-party libraries without types require local `.d.ts`.
- Learning curve for contributors used to JS.

## Mitigation

- Runtime validation is mandatory at every boundary (R1.7) — TS types do not validate at runtime.
- Entity types are **derived** from the validation schema (Zod), not declared separately (R1.6),
  so there is no second source of truth that can drift.

## Rejected alternatives

| Alternative           | Reason for rejection                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| JavaScript with JSDoc | Still loses the full power of generic types; more verbose              |
| Pure JavaScript       | The main cause of weakness in the prior art; explicitly rejected as R1 |
| Flow                  | Ecosystem is effectively dead                                          |
