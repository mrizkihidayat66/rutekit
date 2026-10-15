# RULESET — `rutekit`

**Hard rules & enforcement checklist**
Version: 1.0 · Date: 2026-10-11 · Companion document [CONTRIBUTING.md](CONTRIBUTING.md)

> This document is the **quick-scan summary** of the binding rules.
> If it conflicts with [CONTRIBUTING.md](CONTRIBUTING.md), CONTRIBUTING wins because it carries the rationale.
> The purpose of this document: one page you can read before writing a single line.

---

## R0. Three Rules That Cannot Be Negotiated

| #        | Rule                                                                                         | Consequence of violation         |
| -------- | -------------------------------------------------------------------------------------------- | -------------------------------- |
| **R0.1** | **Frontend and backend must not import each other.** Only `packages/contracts` bridges them. | PR rejected; boundary test fails |
| **R0.2** | **The frontend is finished in full before the backend begins.**                              | Backend work is discarded        |
| **R0.3** | **Backend implementation must not precede the types in `packages/contracts`.**               | PR rejected                      |

---

## R1. Language & Types

| #    | Rule                                                                            | Enforcement                          |
| ---- | ------------------------------------------------------------------------------- | ------------------------------------ |
| R1.1 | No JavaScript (`.js`/`.jsx`) in `apps/` and `packages/`                         | ESLint                               |
| R1.2 | No `any`                                                                        | `@typescript-eslint/no-explicit-any` |
| R1.3 | No `as` except at a parsing boundary + runtime validation                       | Review                               |
| R1.4 | No `@ts-ignore` (use `@ts-expect-error` + a reason)                             | ESLint                               |
| R1.5 | No non-null `!` except after an explicit guard                                  | Review                               |
| R1.6 | Entity types are **derived** from the validation schema, not redeclared         | Parity test                          |
| R1.7 | Every boundary (HTTP, worker stdout, provider response) is validated at runtime | Review                               |

---

## R2. Architectural Boundaries

| #    | Rule                                                                                         | Enforcement        |
| ---- | -------------------------------------------------------------------------------------------- | ------------------ |
| R2.1 | `apps/web` must not import `apps/server`, `hono`, `drizzle`, `bun:*`, `node:*`, `playwright` | `boundary.test.ts` |
| R2.2 | `apps/server` must not import `react`, `react-dom`, `zustand`, `@tanstack/react-query`       | `boundary.test.ts` |
| R2.3 | `packages/contracts` is **dependency-free** — it must not import anything from `apps/`       | Review             |
| R2.4 | `packages/shared` has no I/O                                                                 | Review             |
| R2.5 | `tools/automation-worker` communicates **only** via stdio JSON-lines                         | Review             |
| R2.6 | Adding exceptions to the boundary test is forbidden                                          | ESLint / review    |

---

## R3. Design System

| #    | Rule                                                             | Enforcement        |
| ---- | ---------------------------------------------------------------- | ------------------ |
| R3.1 | No hardcoded colors (`bg-[#fff]`, `color: #333`)                 | ESLint custom rule |
| R3.2 | No hardcoded radius                                              | ESLint custom rule |
| R3.3 | No hardcoded animation duration                                  | ESLint custom rule |
| R3.4 | No inline `style={{}}`                                           | ESLint custom rule |
| R3.5 | Every aligned number must use `tabular-nums`                     | Review             |
| R3.6 | Component responsiveness via container queries                   | Review             |
| R3.7 | Every animation must have a `prefers-reduced-motion` counterpart | Review             |
| R3.8 | Overlays must use `usePresence` + `useModalFocus`                | Review             |
| R3.9 | No Framer Motion / GSAP / anime.js                               | Dependencies       |

---

## R4. Accessibility (not optional)

| #    | Rule                                                                         |
| ---- | ---------------------------------------------------------------------------- |
| R4.1 | Interactive elements use native elements (`button`, `a`, `input`)            |
| R4.2 | Every control has a visible label or an `aria-label`                         |
| R4.3 | Error: `role="alert"`; status update: `role="status"` + `aria-live="polite"` |
| R4.4 | `:focus-visible` ring on every interactive element                           |
| R4.5 | Sortable table headers have `aria-sort`                                      |
| R4.6 | Toggles use `role="switch"` + `aria-checked`                                 |
| R4.7 | Minimum WCAG AA contrast (4.5:1)                                             |
| R4.8 | Decorative icons `aria-hidden="true"`                                        |
| R4.9 | **Every page must be fully operable without a mouse**                        |

---

## R5. Backend

| #     | Rule                                                                               |
| ----- | ---------------------------------------------------------------------------------- |
| R5.1  | Every route with input must use a schema validator                                 |
| R5.2  | Thin route handlers — logic goes to a service                                      |
| R5.3  | The ingress pipeline order must not change without an ADR                          |
| R5.4  | `disabled` is a hard routing exclusion — there is no fallback path to it           |
| R5.5  | Non-essential hooks **must fail-open** (error → `null`, body untouched)            |
| R5.6  | `message_start` is sent first for Claude                                           |
| R5.7  | The stream is primed before committing 200                                         |
| R5.8  | A released migration must not be changed — add a new migration                     |
| R5.9  | Never return a stack trace to the client                                           |
| R5.10 | Provider credentials are encrypted with AES-256-GCM; API keys are stored as hashes |

---

## R6. Frontend

| #    | Rule                                                                 |
| ---- | -------------------------------------------------------------------- |
| R6.1 | TanStack Query for all server state; direct `fetch` is forbidden     |
| R6.2 | Query keys centralized in `data/query-keys.ts`                       |
| R6.3 | Every route lazy-loads + Suspense fallback (never an empty viewport) |
| R6.4 | Every page handles 4 states: loading, empty, error, filled           |
| R6.5 | State that must be bookmarkable is kept in the URL                   |
| R6.6 | Images are downscaled client-side before upload                      |
| R6.7 | Explicit `staleTime`; refetch storms are forbidden                   |

---

## R7. Tests

| #    | Rule                                                                |
| ---- | ------------------------------------------------------------------- |
| R7.1 | The test suite **must be green** on a clean checkout                |
| R7.2 | Coverage ≥85% lines on hand-written `apps/server/src`               |
| R7.3 | Data-driven matrix test for the translator                          |
| R7.4 | A confirmed bug is wrapped in `it.fails()` then promoted when fixed |
| R7.5 | Contract test: every endpoint ↔ contracts schema                    |
| R7.6 | The boundary test must not be deleted or loosened                   |
| R7.7 | Test DB is isolated                                                 |

---

## R8. Working Process

| #    | Rule                                                                    |
| ---- | ----------------------------------------------------------------------- |
| R8.1 | One PR = one purpose                                                    |
| R8.2 | No whole-file rewrites — surgical edits                                 |
| R8.3 | No `--no-verify`                                                        |
| R8.4 | Commits follow Conventional Commits                                     |
| R8.5 | The PR description contains what / why / how to test + a checklist      |
| R8.6 | A new dependency must pass the license check + the 5 questions in §10.1 |

---

## R9. Licenses

| #    | Rule                                                                        |
| ---- | --------------------------------------------------------------------------- |
| R9.1 | **A private, unlicensed source: PATTERNS ONLY. Copying code is FORBIDDEN.** |
| R9.2 | A source with no clear license: patterns only                               |
| R9.3 | open-webui, lobe-chat, chatbox: patterns only                               |
| R9.4 | tldraw, ComfyUI, A1111: patterns only                                       |
| R9.5 | Strong copyleft (GPL/AGPL) only as a separate process + ADR                 |
| R9.6 | Every new dependency's license is checked before it is added                |

---

## Anti-Patterns (Complete List)

```
AP-1   Whole-file rewrite
AP-2   Filter out tool messages
AP-3   Automatic access-token deduplication
AP-4   Send Authorization for Anthropic-Compatible if apiKey is present
AP-5   Call buildXRequest twice
AP-6   Hand-edit auto-generated files
AP-7   A compression hook that can throw
AP-8   Silent fallback to direct egress
AP-9   Silent reroute to another model
AP-10  A home-grown SSE parser
AP-11  Hardcode color/radius/duration
AP-12  Inline style={{}}
AP-13  Red test suite on a clean checkout
AP-14  Exceptions in the boundary test
AP-15  Copying restrictively-licensed code
```

---

## Checklist Before Commit

```
[ ] typecheck clean
[ ] tests green
[ ] boundary test green
[ ] (UI) 4 states tested
[ ] (UI) light & dark tested
[ ] (UI) keyboard-only tested
[ ] (UI) 4 breakpoints tested
[ ] no new style={{}}
[ ] no new hardcoded color/radius/duration
[ ] no new any / as / @ts-ignore
[ ] no new dependency without a license check
[ ] docs updated if needed
```

---

## Context Rule: "May I Start the Backend?"

```
Does 26/26 pages pass all seven "done" criteria?
├── NO → Do the next page. Do not start the backend.
└── YES ─── Do the types for this endpoint already exist in packages/contracts?
          ├── NO → Write the types in contracts first.
          └── YES ─── Start the backend.
```

## Context Rule: "May I Add a Dependency?"

```
1. Can it be achieved with what already exists?   → YES = don't add
2. Is the license compatible (MIT/Apache/BSD)?    → NO = don't add
3. Is the size proportionate to the benefit?      → NO = don't add
4. Is it actively maintained (commit <6 months)?  → NO = don't add
5. Does it not duplicate an existing role?        → NO = don't add
All pass → add it, and record it in an ADR if significant.
```

## Context Rule: "Is This Page Done?"

All seven must be YES:

```
[ ] Perfect at 375 / 768 / 1280 / 1920
[ ] Responsive via container queries
[ ] Fully keyboard-navigable
[ ] Complete ARIA
[ ] Tokenized animation + reduced-motion
[ ] 4 states: loading / empty / error / filled
[ ] No inline style & hardcoded color
```

One missing → the page is **not** done.
