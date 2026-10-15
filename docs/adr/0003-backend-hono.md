# ADR-0003 — Backend framework: Hono

Status: **Accepted** · Date: 2026-10-11 · Related decisions: D3, D12

## Context

The backend must serve the dashboard API, OpenAI-compatible endpoints, and WebSocket, and be
the host for the ingress pipeline that has a strict middleware order. Three main candidates:
Hono, Elysia, Fastify.

## Decision

**Hono.**

## Consequences

**Positive**

- Lightweight (~14KB), runs on Bun without a special adapter.
- Composable middleware — a perfect fit for the staged ingress pipeline (readiness →
  identity → abuse → auth → parse → plan → leases → dispatch).
- Validator (`@hono/zod-validator`) allows schema validation directly in the route,
  in line with R5.1.
- Portable: if it ever needs to run on Node or Deno, the route code does not change.
- Proven for this exact use case — an AI proxy that fans out to many providers.
- Wide middleware ecosystem; WebSocket is available via an adapter.

**Negative / risks**

- Not the highest raw performance on Bun (Elysia wins).
- Does not have end-to-end type safety as strong as Elysia AOT, so runtime validation
  and contract types must be maintained manually — mitigated by ADR-0002 §Mitigation.

## Rejected alternatives

| Alternative | Reason for rejection                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Elysia      | Still beta (2.0), Bun-only (not portable), more frequent breaking changes. Performance is not a deciding factor for a personal router's load |
| Fastify     | Heavier, not Bun-native, Hono's plugin model fits the staged middleware pipeline better                                                      |
| Express     | Not Bun-native, weak type ecosystem                                                                                                          |
