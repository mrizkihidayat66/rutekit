# PRD — `rutekit`

**Product Requirements Document**
Version: 1.0 (draft) · Date: 2026-10-11 · Status: **awaiting review**

---

## 1. Executive Summary

`rutekit` is a **self-hosted AI router & gateway**: one OpenAI-compatible endpoint that aggregates many AI provider accounts behind it. It unifies the most complete provider catalog, the most mature account automation, rich pool tooling, and the strongest UI/UX craft — rebuilt end-to-end in TypeScript.

**What sets it apart from comparable routers:**

1. **The frontend is finished completely before the backend** — every page perfect with mock data, and only then is real functionality wired in.
2. **The frontend/backend split is mechanically enforced** — a test fails if the frontend touches the backend.
3. **Features that exist nowhere else** — dot trick, expiry & TPS per API key, multi-variant benchmark, video studio, model authenticity verification as a complete experience.
4. **UI/UX beyond comparable routers** — one styling strategy (not two mixed idioms), animated theme transitions, no inline styles.

### 1.1 Problems Solved

| Problem                                                            | How `rutekit` answers it                                                         |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Many providers, many API formats — the client has to know them all | One `/v1/*` endpoint, automatic translation to every provider dialect            |
| Provider accounts often hit rate limits / run out of quota         | Account pool with state machine, auto-recovery, quota tracking                   |
| Manual login & account import is tedious                           | Bulk import automation with live browser preview + manual captcha assist         |
| No way to know which provider truly serves which model             | Model authenticity verification (Bayesian fingerprint) + multi-variant benchmark |
| API keys cannot be controlled granularly                           | Quota, models allowed, **expiry**, **TPS**, rate limit, scope per key            |
| AI router dashboards are generally ugly or generic                 | Own design system with motion tokens, OS-style shell, strict a11y                |

### 1.2 Target Users

| Persona                  | Primary need                                                            |
| ------------------------ | ----------------------------------------------------------------------- |
| **Individual developer** | Route coding agents across many providers, save cost, one endpoint      |
| **Power user / homelab** | Full control over the account pool, import automation, quota monitoring |
| **Small team**           | Share managed access via scoped API keys, usage tracking                |

**v1 non-targets:** enterprise (SSO/SAML), multi-tenant SaaS, non-technical users.

---

## 2. Architecture Decisions (Locked)

All the decisions below were chosen through staged brainstorming. These are **constraints**, not suggestions.

| #   | Area              | Decision                                                      | Reason / Consequence                                                      |
| --- | ----------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| D1  | Runtime           | **Bun**                                                       | One runtime for server, tests, package manager                            |
| D2  | Language          | **TypeScript end-to-end**                                     | The translator domain & binary protocols need type safety                 |
| D3  | Backend framework | **Hono**                                                      | Lightweight, portable, composable middleware, WebSocket adapter available |
| D4  | Database          | **SQLite via Drizzle** (PostgreSQL later)                     | Zero-config self-host; Drizzle allows scaling up without swapping the ORM |
| D5  | Distribution      | **CLI (`bunx rutekit`) primary**; binary + Docker alternative | Familiar to developers; binary/Docker come in a later phase               |
| D6  | Provider scope v1 | **~30 curated providers**                                     | Quality > quantity; every provider fully tested + has a quota checker     |
| D7  | Styling           | **Tailwind CSS 4 + CSS custom properties**                    | Tokens as single source of truth; avoids mixing two styling idioms        |
| D8  | Auth v1           | **Single-user + password** (session cookie)                   | Enough for self-hosted; multi-user/role/OIDC in v2+                       |
| D9  | Automation        | **Separate Node subprocess for Playwright**                   | Playwright officially supports Node, not Bun — compatibility guaranteed   |
| D10 | Monorepo          | **Bun workspaces**                                            | Zero-config, enough for 3–5 packages                                      |
| D11 | UI components     | **Radix UI primitives + custom styling**                      | Behavior + a11y for free, 100% visual control                             |
| D12 | Real-time         | **WebSocket for everything**                                  | One transport: live log, account status, screenshot, job progress         |
| D13 | UI language       | **English only (v1)**                                         | i18n framework prepared, only the `en` locale filled                      |
| D14 | Design system     | **No codename** — token prefix directly                       | `--color-*`, `--radius-*`, `--dur-*`                                      |
| D15 | Chat page         | **Tiered Provider → Model picker**                            | User picks the provider first, then a model from that provider            |
| D16 | Studio page       | **Prompt-first + gallery** (not a canvas editor)              | Focus on prompt→result→gallery; canvas editor comes in v2                 |
| D17 | Dot trick         | **Standalone utility on the Tools page**                      | Enter email, pick a method, generate N variants, copy/export              |

---

## 3. Target Architecture

### 3.1 Monorepo Structure

```
rutekit/
├── apps/
│   ├── web/                    # FRONTEND — React 19 + Vite
│   └── server/                 # BACKEND — Bun + Hono
├── packages/
│   ├── contracts/              # SHARED TYPES & SCHEMAS — the only bridge
│   ├── provider-registry/      # declarative provider definitions
│   ├── translator/             # protocol translation engine
│   ├── compression/            # multi-stage compression pipeline
│   └── shared/                 # pure utilities with no I/O
├── tools/
│   └── automation-worker/      # Node subprocess (Playwright) — D9
├── docs/
│   ├── plan/                   # PRD, roadmap, guidelines (this document)
│   └── adr/                    # Architecture Decision Records
├── package.json                # Bun workspaces (D10)
├── bunfig.toml
└── tsconfig.json
```

### 3.2 Mechanically Enforced Boundaries

This is a **core user constraint** ("frontend and backend are separated") — and it is guaranteed by a test, not by convention:

**Rules:**

1. `apps/web` **must not** import `apps/server`.
2. `apps/web` **must not** import `node:*`, Hono, Drizzle, a DB driver, or Playwright.
3. `packages/contracts` is the **only** place request/response types live.
4. `apps/server` **must not** import React or anything from `apps/web`.
5. `tools/automation-worker` communicates with `apps/server` **only** via stdio JSON-lines.

**Enforcement:** `apps/web/test/boundary.test.ts` walks the import graph from `apps/web/src` and fails on the first module violating rules 1–2. `apps/server/test/boundary.test.ts` is the equivalent for rule 4.

### 3.3 Request Flow (data plane)

```
client (OpenAI-compatible)
  → apps/server/src/ingress/       (read body once, identity, IP-abuse, API key auth)
  → apps/server/src/plan/          (alias → combo → eligibility → capability filter)
  → apps/server/src/pool/          (admission, pick account, reservation)
  → packages/translator/           (OpenAI pivot + direct route for fragile pairs)
  → packages/compression/          (TSC → DCP → RTK → Caveman → Cache Markers, fail-open)
  → provider dispatcher            (stream primed before committing 200)
  → SSE to client
```

### 3.4 Final Tech Stack

| Layer        | Technology                                    | Target version |
| ------------ | --------------------------------------------- | -------------- |
| Runtime      | Bun                                           | ≥1.2           |
| Language     | TypeScript                                    | 5.9+           |
| Backend      | Hono                                          | 4.x            |
| ORM          | Drizzle ORM                                   | 0.45+          |
| DB           | SQLite (`bun:sqlite`) → PostgreSQL (optional) | —              |
| Frontend     | React 19 + Vite                               | 19.x / 7.x     |
| FE routing   | React Router                                  | 7.x            |
| Styling      | Tailwind CSS 4 + CSS custom properties        | 4.x            |
| Components   | Radix UI primitives                           | latest         |
| Icons        | lucide-react                                  | latest         |
| Server state | TanStack Query                                | 5.x            |
| UI state     | Zustand                                       | 5.x            |
| Animation    | CSS keyframes + transitions (tokenized)       | —              |
| Markdown     | react-markdown + remark-gfm + shiki           | —              |
| Chart        | Recharts                                      | 3.x            |
| Editor       | Monaco (JSON/config only)                     | latest         |
| Automation   | Playwright + Camoufox                         | 1.5x           |
| Real-time    | WebSocket (hono/ws)                           | —              |
| Test         | Vitest                                        | 3.x            |
| Mock         | MSW (Mock Service Worker)                     | 2.x            |

**Explicitly rejected:** Framer Motion, shadcn/ui, Next.js, Prisma, tRPC, and JavaScript without TypeScript.

---

## 4. Build Phases

User constraint: **frontend first until every page is complete, then the backend.**

### PHASE A — Foundation & Contracts

- Set up the Bun workspaces monorepo.
- `packages/contracts` — all request/response types.
- Design system: CSS tokens, styled Radix primitives, shell, motion.
- FE routing, layout, boundary test, MSW with mock handlers from the contracts.

### PHASE B — Complete Frontend

All 26 pages built with mock data. **Definition of "done"** for one page:

1. Displays perfectly at 4 breakpoints (mobile 375 / tablet 768 / laptop 1280 / desktop 1920).
2. Responsive via container queries, not just media queries.
3. Fully keyboard-navigable; complete ARIA.
4. Animated per the motion tokens; `prefers-reduced-motion` respected.
5. Survives 4 states: **loading (skeleton), empty, error, and populated**.
6. Mock data from MSW; no direct `fetch`.
7. No inline `style={{}}`; no hardcoded colors (`bg-[#E56A4A]` is forbidden).

### PHASE C — Backend & Wiring

Implement `packages/contracts` in `apps/server`; replace MSW handlers one by one with real endpoints. Provider registry, translator, compression, pool, automation engine, persistence, auth.

### PHASE D — Hardening

Green test suite, boundary tests, DB self-migration, graceful shutdown, documentation.

**B→C transition rule:** the backend **does not start** before all 26 pages pass the "done" definition above.

---

## 5. Page List (27)

Sidebar with 6 sections:

| Section        | #   | Page               | Route              | Priority |
| -------------- | --- | ------------------ | ------------------ | -------- |
| **Overview**   | 1   | Dashboard          | `/`                | P0       |
|                | 2   | Usage & Metrics    | `/usage`           | P0       |
|                | 3   | Console Log        | `/console-log`     | P1       |
| **Providers**  | 4   | Provider Catalog   | `/providers`       | P0       |
|                | 5   | Provider Detail    | `/providers/:id`   | P0       |
|                | 6   | Model Catalog      | `/models`          | P1       |
|                | 7   | Accounts           | `/accounts`        | P0       |
|                | 8   | Quota Management   | `/quota`           | P0       |
| **Routing**    | 9   | Combos & Routes    | `/combos`          | P0       |
|                | 10  | Model Mapping      | `/model-mapping`   | P1       |
|                | 11  | Filter Rules       | `/filter-rules`    | P1       |
|                | 12  | Token Saver        | `/token-saver`     | P1       |
|                | 13  | API Keys           | `/api-keys`        | P0       |
| **Automation** | 14  | Automation         | `/automation`      | P0       |
|                | 15  | Automation Logs    | `/automation/logs` | P1       |
|                | 16  | Proxy Pool         | `/proxy`           | P1       |
|                | 17  | SMS Providers      | `/sms-providers`   | P1       |
| **Tools**      | 18  | Chat               | `/chat`            | P0       |
|                | 19  | Studio             | `/studio`          | P0       |
|                | 20  | Benchmark          | `/benchmark`       | P1       |
|                | 21  | Model Verification | `/verification`    | P1       |
|                | 22  | Dot Trick + VCC    | `/tools`           | P2       |
|                | 23  | CLI Tools          | `/cli-tools`       | P2       |
| **System**     | 24  | Customization      | `/customization`   | P2       |
|                | 25  | Settings           | `/settings`        | P1       |
| **Auth**       | 26  | Login              | `/login`           | P0       |
|                | 27  | Setup              | `/setup`           | P0       |

_(27 pages. `/providers/:id` is reached from the catalog, not from the rail; both Auth pages sit outside the shell because the shell does not exist yet when those pages render. CLI Tools was added in C13c — it was not in the initial list of 26, and ADR-0033 records why it was eventually needed.)_

---

## 6. Requirements per Feature

### 6.1 Router & Gateway (P0)

**FR-1.1** — Accepts all five surfaces: `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/completions`, `/v1/models`.
**FR-1.2** — Translator with OpenAI as pivot + direct route for fragile pairs (thinking blocks, binary upstream).
**FR-1.3** — Alias: friendly name → real model.
**FR-1.4** — Combo: multi-model ordering with fallback.
**FR-1.5** — Model mapping: rewrite the model ID at the edge.
**FR-1.6** — Capability-aware routing: if a model cannot express what was asked for, drop the control or substitute a placeholder — **do not** silently swap the model.
**FR-1.7** — SSE streaming: `message_start` is sent first for Claude; the stream is primed before committing 200.

### 6.2 Provider (P0)

**FR-2.1** — Declarative registry: one file per provider, auto-generated index.
**FR-2.2** — ~30 curated providers for v1, across categories: OAuth, API-key, media, search, local.
**FR-2.3** — Per-provider auth: API key, OAuth (browser + device flow).
**FR-2.4** — BYOK provider (OpenAI-compatible / Anthropic-compatible) with test connection.
**FR-2.5** — BYOK grouped as its own separate category.

### 6.3 Account Pool (P0)

**FR-3.1** — State machine: `active`, `banned`, `disabled`, `exhausted`, `error`, `pending`, `rate_limited`.
**FR-3.2** — Load balancing: `round_robin` (least-inflight bias) or `sequential`.
**FR-3.3** — Auto-recovery: rate-limited recovers after TTL; exhausted recovers when quota resets.
**FR-3.4** — In-flight tracking per account.
**FR-3.5** — Warmup scheduler per provider (configurable interval).
**FR-3.6** — Quota tracking per account: limit, remaining, reset time.

### 6.4 Quota Checker (P0)

**FR-4.1** — Quota page shows the limit per provider with a progress bar.
**FR-4.2** — Manual + periodic automatic refresh.
**FR-4.3** — Cross-account quota table with sorting.
**FR-4.4** — Credit reset row with a countdown indicator.

### 6.5 Automation (P0)

**FR-5.1** — Bulk account import: `email:password` or `email|password` line input.
**FR-5.2** — **Live browser preview** — periodic JPEG screenshot (default 2s) → base64 → WebSocket → dashboard. _(= "xvfb previewer")_
**FR-5.3** — **Captcha detection** via text markers (including CJK markers: 两步验证, 双重验证, 验证您的身份).
**FR-5.4** — **`needs_manual` status** that **stays active** (not failed) — the job waits for an operator.
**FR-5.5** — **Manual input until timeout** — the operator solves the challenge in the browser session; if the timeout is reached, the job moves on to the next account.
**FR-5.6** — **Failed retry** with exponential backoff (base 2s, cap 15s; per-provider retry limit).
**FR-5.7** — Manual session endpoint per worker.
**FR-5.8** — Worker concurrency adaptive to the machine spec.
**FR-5.9** — Browser engine selection: Chromium (fast) or Camoufox (stealth).
**FR-5.10** — Stall detection: process is killed after N seconds without activity.
**FR-5.11** — Persist job snapshot for crash recovery.
**FR-5.12** — Real-time `onStep` reporting to the UI.

### 6.6 API Key Control (P0 — beyond every comparable router)

**FR-6.1** — Scope: allow/deny model per key.
**FR-6.2** — Quota: request and token budget per key.
**FR-6.3** — **Expiry per key** — expiration date/time. _(gap G2)_
**FR-6.4** — **TPS limit per key** — tokens per second. _(gap G3)_
**FR-6.5** — Request rate limit per key.
**FR-6.6** — Client-router denylist (best-effort header label).
**FR-6.7** — Secret shown once with a copy button.

### 6.7 Chat (P0)

**FR-7.1** — **Tiered Provider → Model selection** (D15): pick the provider first, then a model from that provider.
**FR-7.2** — Streaming response (SSE) with an accumulator.
**FR-7.3** — Markdown + code block with syntax highlight + copy button.
**FR-7.4** — Thinking/reasoning block — inline while streaming, collapsible once finished.
**FR-7.5** — Tool calls as collapsible chips (`name`, `→ args`, `← result`).
**FR-7.6** — Attachment: images (client-side downscale), text files, drag-drop, paste.
**FR-7.7** — Session management: new, rename, delete, export.
**FR-7.8** — Message actions: copy, edit, regenerate, branch.
**FR-7.9** — Message meta: TTFT, total, tokens in/out.
**FR-7.10** — Thinking level selector: auto/low/medium/high/xhigh/max.

### 6.8 Studio (P0)

**FR-8.1** — **Prompt-first** (D16): pick a vision-capable model, type a prompt, generate.
**FR-8.2** — Parameter panel: steps, size, guidance, seed.
**FR-8.3** — Result gallery grid with infinite scroll.
**FR-8.4** — Detail view: fullsize + metadata + download + refine/upscale/variation.
**FR-8.5** — **Video generation** from a prompt: progress bar + preview player. _(gap G4)_
**FR-8.6** — Persistent generation history.

### 6.9 Benchmark (P1)

**FR-9.1** — **Multi-variant template test** (gap G5): one prompt template × N variants × M providers/models.
**FR-9.2** — Metrics: TTFT, latency, tokens/second, cost, quality score.
**FR-9.3** — Comparison table + chart.
**FR-9.4** — Export results (JSON/CSV).

### 6.10 Model Verification (P1)

**FR-10.1** — Diagnostic probes: identity, code, reasoning, instruction-following + **negative control**.
**FR-10.2** — Model family fingerprint via **Bayesian** evidence accumulation → posterior distribution.
**FR-10.3** — Posterior distribution visualization per endpoint.
**FR-10.4** — bazaarlink endpoint support.

### 6.11 Tooling (P2)

**FR-11.1** — **Dot trick**: email input → multiple variants via dot (`.`) / plus (`+`); generate N variants; copy/export CSV. _(gap G1)_
**FR-11.2** — **VCC pool**: generate Luhn-valid cards from a BIN; brand detection; card lifecycle.
**FR-11.3** — **Content filter**: regex + exact string, DB-backed, editable.

### 6.12 Observability (P1)

**FR-12.1** — Live console log via WebSocket.
**FR-12.2** — Request inspector with payload capture (redacted, TTL).
**FR-12.3** — Usage tracking + periodic charts.
**FR-12.4** — Cost tracking.

---

## 7. Design System

### 7.1 Tokens

```css
:root {
  /* Color — light */
  --color-page: #f7f3ed;
  --color-surface-1: #fffdf8;
  --color-surface-2: #fffefc;
  --color-border: #e4d7cb;
  --color-text: #2d2926;
  --color-text-muted: #6b6259;
  --color-accent: #2e2e32;
  --color-success: #4c9368;
  --color-danger: #c95145;
  --color-warning: #d97706;
  --color-info: #3b82f6;

  /* Radius */
  --radius-control: 10px;
  --radius-card: 18px;
  --radius-sidebar: 20px;
  --radius-pill: 9999px;

  /* Motion */
  --ease-spring: cubic-bezier(0.32, 0.72, 0, 1);
  --dur-micro: 150ms;
  --dur-macro: 250ms;

  /* Typography */
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'Geist Mono', ui-monospace, monospace;
  --font-head: 'Space Grotesk', 'Inter', sans-serif;
}

[data-theme='dark'] {
  --color-page: #08080b;
  --color-surface-1: #1c1c20;
  --color-surface-2: #222228;
  --color-text: #f5f5f7;
  --color-accent: #f5f5f7;
  /* ... */
}
```

### 7.2 Rules

1. **Every color, radius, and duration is a token.** Hardcoding is forbidden.
2. **`font-variant-numeric: tabular-nums`** on all numbers in columns.
3. **Root font-size 14px** for the dense "pro tool" feel.
4. **Container queries** over media queries for component responsiveness.
5. **Universal `prefers-reduced-motion`** — all durations → 0.01ms.
6. **Animated theme transitions** — this is where it goes beyond comparable routers.
7. **No inline `style={{}}`.** Everything via classes or CSS custom properties.

### 7.3 Shared Overlay Pattern

One contract for Dialog, Drawer, and Command Palette:

- `usePresence(open, exitMs)` → `{ mounted, closing }` — enter **and** exit animation.
- `useModalFocus` — Tab trap, Escape, scroll lock, restore focus to the opener.
- A real backdrop `<button>` for keyboard operability.

### 7.4 Shell

```
┌─────────────────────────────────────────────────────┐
│ ┌──────────┐ ┌────────────────────────────────────┐ │
│ │ Sidebar  │ │ Topbar (sticky)                    │ │
│ │ 272px    │ ├────────────────────────────────────┤ │
│ │          │ │                                    │ │
│ │ Main     │ │  Main Column — the only            │ │
│ │ Control  │ │  scroller (invisible scrollbar)    │ │
│ │ System   │ │                                    │ │
│ │          │ │                                    │ │
│ ├──────────┤ ├────────────────────────────────────┤ │
│ │ Footer   │ │ Footer — UTC / system time / uptime│ │
│ └──────────┘ └────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
grid-template-columns: 272px minmax(0, 1fr);
max-width: none (adaptive for ultrawide — R13 fix);
padding: 16px; gap: 16px; height: 100dvh;
```

---

## 8. Non-Functional Requirements

| #      | Requirement                                      | Target    |
| ------ | ------------------------------------------------ | --------- |
| NFR-1  | Frontend/backend boundary enforced by test       | Must pass |
| NFR-2  | Backend test coverage (lines, hand-written code) | ≥85%      |
| NFR-3  | Test suite green on a clean checkout             | Required  |
| NFR-4  | Page open time (LCP, local)                      | <1.5s     |
| NFR-5  | Every page accessible via keyboard alone         | Required  |
| NFR-6  | WCAG AA text contrast (4.5:1)                    | Required  |
| NFR-7  | Bottle: self-migration on boot                   | Required  |
| NFR-8  | Graceful shutdown: drain + `503 shutting_down`   | Required  |
| NFR-9  | Frontend bundle size (gzip, initial)             | <300KB    |
| NFR-10 | Motion respects `prefers-reduced-motion`         | Required  |

---

## 9. Security

| #     | Control                                                                   |
| ----- | ------------------------------------------------------------------------- |
| SEC-1 | API keys stored as hashes; the secret is shown once                       |
| SEC-2 | Provider credentials encrypted with AES-256-GCM + scrypt                  |
| SEC-3 | IP derivation: reject `X-Forwarded-For` from non-loopback (A24)           |
| SEC-4 | SSRF: validate proxy egress at creation and connection; network allowlist |
| SEC-5 | No silent fallback to direct egress when the pool fails                   |
| SEC-6 | Payload capture redacted + 15-minute TTL                                  |
| SEC-7 | Backup export is password-gated                                           |
| SEC-8 | Single-user dashboard; password hashing with Argon2id                     |

**Adoption boundary:** a privately licensed source contributes patterns only — no code is copied.

---

## 10. Success Metrics

| Metric                                                    | v1 target                 |
| --------------------------------------------------------- | ------------------------- |
| Providers supported & fully tested                        | ≥30                       |
| Pages passing the "done" definition                       | 26/26                     |
| Boundary test                                             | Green                     |
| Bulk import succeeding for supporting providers           | ≥90% (with manual assist) |
| Quota checker working for supporting providers            | 100%                      |
| Model authenticity verification: accuracy on known models | ≥80%                      |

---

## 11. Out of Scope for v1

- Multi-user, roles, RBAC, SSO/SAML/OIDC
- Multi-device cloud sync
- Canva-like canvas editor in Studio (v2)
- ComfyUI-style node editor (v2)
- MITM proxy (v2, optional)
- i18n beyond English
- Multi-tenant / SaaS
- Plugin/skill marketplace

---

## 12. Key Risks

| Risk                                      | Probability | Impact | Mitigation                                    |
| ----------------------------------------- | ----------- | ------ | --------------------------------------------- |
| The scope of 4 projects is too large      | High        | High   | Firm sequential phases; frontend first        |
| Third-party code absorbed unintentionally | Medium      | High   | Hard rule: patterns only, no files            |
| Playwright + Bun compatibility            | Medium      | Medium | Separate Node subprocess (D9)                 |
| 30 providers remain heavy to test         | Medium      | Medium | Data-driven matrix test                       |
| Automation captcha = sensitive area       | Medium      | Medium | Self-hosted framing; compliance documentation |
