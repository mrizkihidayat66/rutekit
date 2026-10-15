# CONTRIBUTING — Coding & Contribution Guidelines for `rutekit`

Version: 0.1.0 · Last updated: 2026-10-15

This document is the **authoritative reference** for `rutekit` code. Where documents
conflict, this one wins on matters of process.

---

## 1. Fundamental Principles

### 1.1 Four Values

| Value                           | What it means in practice                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| **Clear boundaries**            | Frontend and backend are separated mechanically. `packages/contracts` is the only bridge. |
| **Fail-open on critical paths** | Compression, filters, and non-essential hooks **never** break a request. Error → no-op.   |
| **Explicit over implicit**      | No magic. No silent auto-mutation. No hidden fallback.                                    |
| **Craft, not configuration**    | Polish comes from writing discipline, not from adding libraries.                          |

### 1.2 Golden Rules (violation = PR rejected)

1. **Never write JavaScript without TypeScript.** No `.js` in `apps/` or `packages/` except config files.
2. **Never import across boundaries** forbidden by §3.
3. **Never write hardcoded color, radius, or duration.** Always a token.
4. **Never use inline `style={{}}`.** Everything via classes or a CSS custom property.
5. **Never build your own SSE parser.** Use the AI SDK.
6. **Never write a compression/filter hook that can throw.** Fail-open.
7. **Never copy code from a restrictively-licensed project.** See §9.
8. **Always test all four states:** loading, empty, error, filled.
9. **Always test light & dark.**
10. **Always send `message_start` first** for Claude streaming.

---

## 2. Structure & Naming

### 2.1 Directory Structure

```
rutekit/
├── apps/
│   ├── web/                    # React 19 + Vite
│   │   └── src/
│   │       ├── app/            # router, providers, error boundary
│   │       ├── components/
│   │       │   ├── ui/         # design-system primitives
│   │       │   ├── patterns/   # cross-page compositions
│   │       │   └── <domain>/   # domain-specific components
│   │       ├── routes/         # one file per page
│   │       ├── features/       # vertical slices
│   │       ├── hooks/          # one file per domain
│   │       ├── data/           # api client, query keys, msw handlers
│   │       ├── styles/         # tokens.css, base.css, extensions
│   │       └── lib/            # pure utilities
│   └── server/                 # Bun + Hono
│       └── src/
│           ├── main.ts         # entry
│           ├── app.ts          # composition
│           ├── ingress/        # middleware pipeline
│           ├── plan/           # alias → combo → eligibility
│           ├── pool/           # account pool
│           ├── providers/      # runtime adapters
│           ├── routes/         # Hono route per domain
│           ├── persistence/    # drizzle, repos, migrations
│           ├── automation/     # bridge to the worker
│           ├── observability/  # telemetry, logger, metrics
│           └── runtime/        # lifecycle, config, shutdown
├── packages/
│   ├── contracts/              # TYPES & SCHEMAS — the only bridge
│   ├── provider-registry/      # declarative provider definitions
│   ├── translator/             # protocol translation engine
│   ├── compression/            # compression pipeline
│   └── shared/                 # pure utilities without I/O
├── tools/
│   └── automation-worker/      # Node subprocess (Playwright)
└── docs/
```

**Placement rule:** if only **one** page uses it, it lives next to that page (`routes/<page>/`). Only cross-page things go into `components/`.

### 2.2 Naming

| Kind                | Convention            | Example                  |
| ------------------- | --------------------- | ------------------------ |
| Folder              | `kebab-case`          | `account-pool/`          |
| Component file      | `PascalCase.tsx`      | `ProviderCard.tsx`       |
| Hook file           | `use-<domain>.ts`     | `use-accounts.ts`        |
| Utility file        | `kebab-case.ts`       | `format-duration.ts`     |
| Type file           | `kebab-case.ts`       | `provider-types.ts`      |
| Type / Interface    | `PascalCase`          | `AccountState`           |
| Function / variable | `camelCase`           | `resolveAccountForModel` |
| Constant            | `SCREAMING_SNAKE`     | `MAX_ATTACH_BYTES`       |
| CSS custom property | `--<category>-<name>` | `--color-surface-1`      |
| CSS class           | `kebab-case`          | `.card-header-title`     |
| WebSocket event     | `kebab-case`          | `job-progress`           |
| DB table            | plural `snake_case`   | `api_keys`               |
| DB column           | `snake_case`          | `created_at`             |

**Import aliases** (required, consistent):

```json
{
  "@web/*": ["./apps/web/src/*"],
  "@server/*": ["./apps/server/src/*"],
  "@contracts": ["./packages/contracts/src/index.ts"],
  "@shared/*": ["./packages/shared/src/*"]
}
```

### 2.3 File Length Limits

| File kind                         | Soft limit | Action when exceeded                    |
| --------------------------------- | ---------- | --------------------------------------- |
| Component                         | 300 lines  | Split sub-components into a folder      |
| Hook                              | 200 lines  | Split by responsibility                 |
| Route handler                     | 150 lines  | Move the logic into a service           |
| Utility                           | 100 lines  | Split per function                      |
| Server module (`apps/server/src`) | 200 lines  | Split by responsibility                 |
| Single CSS file                   | 800 lines  | Split per section with labeled comments |

**A server module** is a single class or a single cohesive file — a realtime hub, a config parser, a rate limiter, an error taxonomy. Its limit is 200, not the Utility limit of 100: a class with a single responsibility (per-channel fan-out, for instance) is not better split across files, and forcing it into the Utility category only drives harmful fragmentation. What gets split is a file handling two responsibilities, not one that is long because of a single one.

---

## 3. Frontend/Backend Boundary (Enforced by Tests)

### 3.1 Forbidden Import Matrix

| From                         | Forbidden to import                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `apps/web/**`                | `apps/server/**`, `hono`, `drizzle-orm`, `bun:sqlite`, `node:*`, `playwright`, `pino`  |
| `apps/server/**`             | `apps/web/**`, `react`, `react-dom`, `@tanstack/react-query`, `zustand`, `tailwindcss` |
| `packages/contracts/**`      | anything from `apps/**` (must be dependency-free)                                      |
| `packages/shared/**`         | anything from `apps/**`, and must not perform I/O                                      |
| `tools/automation-worker/**` | `apps/server/**` (communication via stdio only)                                        |

### 3.2 How the Boundary Test Works

`apps/web/test/boundary.test.ts` walks the import graph from `apps/web/src` recursively and fails on the first module that violates it. The error message names the module and its import path.

```ts
// Implementation pattern
const FORBIDDEN_BY_APP = {
  web: ['hono', 'drizzle-orm', 'playwright', 'pino', /^node:/, /^bun:/],
  server: ['react', 'react-dom', '@tanstack/react-query', 'zustand'],
};
// Walk, report, assert empty.
```

**If the boundary test fails:** fix the architecture, **do not** add an exception. If you genuinely need a type from the other side, that type **must** move into `packages/contracts`.

---

## 4. TypeScript

### 4.1 Configuration

```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "noFallthroughCasesInSwitch": true,
  },
}
```

### 4.2 Rules

| #     | Rule                                                                                                                                            |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| TS-1  | **No `any`.** Use `unknown` + narrowing, or a specific type.                                                                                    |
| TS-2  | **No `as`** except at a parsing boundary with runtime validation afterwards.                                                                    |
| TS-3  | **No `@ts-ignore`.** Use `@ts-expect-error` with a comment explaining why.                                                                      |
| TS-4  | **No non-null assertion (`!`)** except after an explicit guard on the previous line.                                                            |
| TS-5  | Every public function has an explicit return type.                                                                                              |
| TS-6  | Use `type` for unions/utility types, `interface` for objects that can be extended.                                                              |
| TS-7  | `import type` for type-only imports (`verbatimModuleSyntax`).                                                                                   |
| TS-8  | **Runtime validation is required at every boundary** — HTTP endpoints, worker stdout, provider responses. TS types validate nothing at runtime. |
| TS-9  | Enums → use an `as const` object + a derived union type.                                                                                        |
| TS-10 | Export via a barrel **only** in `packages/*/src/index.ts`; inside `apps/` import directly from the file.                                        |

### 4.3 A Single Source of Truth for Data Shape

For every entity, the TS type **and** the runtime validation schema live side by side, with a parity test:

```ts
// packages/contracts/src/entities/api-key.ts
export const apiKeySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  modelsAllowed: z.array(z.string()),
  expiresAt: z.coerce.date().nullable(),
  tpsLimit: z.number().int().positive().nullable(),
  rateLimit: z.number().int().positive().nullable(),
  budgetTokens: z.number().int().positive().nullable(),
});
export type ApiKey = z.infer<typeof apiKeySchema>;
```

**Forbidden** to declare a type separately from the schema — always derive it from the schema.

---

## 5. Backend (Hono)

### 5.1 Route Structure

```ts
// apps/server/src/routes/api-keys.ts
export const apiKeysRoutes = new Hono()
  .get('/', async (c) => {
    /* ... */
  })
  .post('/', zValidator('json', createApiKeySchema), async (c) => {
    const input = c.req.valid('json'); // already validated
    /* ... */
  });
```

**Rules:**

- Every route with input **must** use a schema validator from `packages/contracts`.
- Route handlers are **thin** — logic goes to `services/`.
- Errors are thrown as a typed `AppError`; the error-lifecycle middleware formats them.
- Never return a raw error, including a stack trace, to the client.

### 5.2 Ingress Pipeline

The order is **fixed** (do not change without an ADR):

```
readiness → identity (safe IP) → IP-abuse → API-key auth
→ canonical parse → route prepare → plan → leases → dispatch → completeAttempt
```

The per-IP abuse check is attached to the root composition's `request` hook, **not** a pipeline stage, so that it also counts requests that have no route.

### 5.3 Pool & Account State

```ts
type AccountState =
  'active' | 'banned' | 'disabled' | 'exhausted' | 'error' | 'pending' | 'rate_limited';
```

**Legal transitions** (do not add without an ADR):

| From           | To             | Trigger                        |
| -------------- | -------------- | ------------------------------ |
| `active`       | `rate_limited` | Upstream 429 response          |
| `active`       | `exhausted`    | Quota exhausted                |
| `active`       | `error`        | Transient failure              |
| `active`       | `disabled`     | Credentials hard-rejected      |
| `rate_limited` | `active`       | TTL expires                    |
| `exhausted`    | `active`       | Daily quota reset              |
| `error`        | `active`       | Warmup / successful retry      |
| `disabled`     | —              | Manual only (no auto-recovery) |

**`disabled` is a hard routing exclusion.** Never build a path that routes to a `disabled` account "as a last resort".

### 5.4 Persistence

- Drizzle schema in `persistence/schema/` — one file per table group.
- Numbered migrations: `NNNN_name.sql`, auto-applied on boot, recorded in the `schema_migrations` ledger.
- `0000_baseline.sql` is the **entire schema** for a new DB; migrations after it are incremental.
- **Forbidden** to change a released migration. Add a new one.

### 5.5 Fail-Open Contract

Every non-essential hook (compression, filter, RTK) **must** follow the contract:

```ts
function applyCompression(body: Body): Body | null {
  try {
    // ...
    return compressed;
  } catch {
    return null; // ← REQUIRED: the caller uses the original body
  }
}
```

**Reason:** a user request must not fail because of internal optimization. This is a hard rule — the failure has happened on a prior project.

### 5.6 Streaming

- **Always** send `message_start` first for Claude.
- **The stream is primed before committing 200** — do not send a success status before the first chunk arrives.
- Timeout names use the `RUTEKIT_*` prefix: first-chunk, stall, upstream.
- Never close a stream without a proper `message_stop`/`[DONE]`.

---

## 6. Frontend (React)

### 6.1 Components

```tsx
// Standard pattern
export function ProviderCard({ provider, onSelect }: ProviderCardProps) {
  return (
    <Card interactive depth={2}>
      {/* ... */}
    </Card>
  );
}
```

**Rules:**

- Functional components only. No class components.
- One component, one file, one primary export.
- Explicitly typed props; **no** `React.FC`.
- `forwardRef` only when a ref must be forwarded (UI primitives).
- Hooks at the top, handlers in the middle, JSX at the bottom. Consistently.
- **Domain state in the URL** if it must be bookmarkable (filters, tabs, page).

### 6.2 Data Fetching

- TanStack Query for **all** server state. No direct `fetch` in components.
- Query keys centralized in `data/query-keys.ts`.
- Prefetch on nav-link hover/focus.
- **The session is primed into the cache** in the route guard so that consumers do not each trigger a request (which would double-count login attempts against the rate limit).

### 6.3 Styling

```tsx
// RIGHT
<div className="rounded-[--radius-card] bg-[--color-surface-1] p-4">

// WRONG — hardcoded color
<div className="rounded-2xl bg-[#fffdf8] p-4">

// WRONG — inline style
<div style={{ borderRadius: 18, background: '#fffdf8' }}>
```

**Rules:**

- All visual values come from tokens (D7).
- Semantic classes in CSS for complex components (shell, overlay, multi-step animation).
- Tailwind for layout, spacing, and simple variants.
- `font-variant-numeric: tabular-nums` on **all** aligned numbers.
- Container queries over media queries for component responsiveness.
- **No inline `style={{}}`** — the only exception is a value that is genuinely dynamic at runtime (e.g. `--blur-depth` from a slider), and even then via a CSS custom property.

### 6.4 Animation

- Only tokenized CSS keyframes + transitions.
- **Forbidden**: Framer Motion, GSAP, anime.js.
- Every animation has a `prefers-reduced-motion` counterpart.
- Durations only from `--dur-micro` (150ms) or `--dur-macro` (250ms).
- Easing only `--ease-spring`.
- Descriptive keyframe names: `dialog-panel-in`, not `anim1`.

### 6.5 Shared Overlays

All overlays (Dialog, Drawer, Command Palette) **must** use:

- `usePresence(open, exitMs)` — enter **and** exit animation.
- `useModalFocus` — Tab trap, Escape, scroll lock, restore focus to the opener.
- A real backdrop `<button>` for keyboard operability.

Do not build a new overlay with your own focus logic.

### 6.6 Accessibility (required, not optional)

| Requirement          | Detail                                                                         |
| -------------------- | ------------------------------------------------------------------------------ |
| Interactive elements | Native `<button>`, `<a>`, `<input>`. Not `<div onClick>`.                      |
| Label                | Every control has a visible label or an `aria-label`.                          |
| Live region          | `role="status"` + `aria-live="polite"` for updates; `role="alert"` for errors. |
| Focus                | `:focus-visible` ring on **every** interactive element.                        |
| Sortable table       | `aria-sort` on the header.                                                     |
| Toggle               | `role="switch"` + `aria-checked`; `aria-pressed` for toggle buttons.           |
| Contrast             | WCAG AA minimum 4.5:1 (NFR-6).                                                 |
| Decorative icons     | `aria-hidden="true"`.                                                          |
| Motion               | `prefers-reduced-motion` respected (NFR-10).                                   |

### 6.7 Mock Data Quality

MSW handlers **must** provide realistic data, not `"lorem ipsum"`:

- 30 real providers with the correct names & icons.
- Sensible usage numbers (not all `0`).
- Simulated failures to exercise error states.
- Simulated latency of 50–400ms.

---

## 7. Tests

### 7.1 Pyramid

| Level       | Scope                                                                     | Tool                       |
| ----------- | ------------------------------------------------------------------------- | -------------------------- |
| Unit        | Pure functions, reducers, formatters, algorithms                          | Vitest                     |
| Contract    | Every endpoint ↔ `packages/contracts` schema                              | Vitest + schema validation |
| Integration | Route handler → pool → DB                                                 | Vitest + isolated DB       |
| Boundary    | Frontend/backend boundary                                                 | Vitest                     |
| Parity      | Mirror configuration (session, usage dimensions, provider list, icon map) | Vitest                     |
| E2E         | User flows                                                                | Vitest + browser           |

### 7.2 Rules

- **85% line coverage gate** on hand-written `apps/server/src` (NFR-2).
- **Data-driven matrix test** for the translator — it reads the provider list so that a new provider is covered automatically.
- **`it.fails()` for bug tracking** — a confirmed bug is wrapped in `it.fails`; once it is fixed the test turns red and reminds you to promote it to `it()`.
- Tests **must be green** on a clean checkout (NFR-3) — a direct fix for a weakness seen on a prior project.
- Test DB isolated via a dedicated env var.

### 7.3 Test Naming

```ts
describe('AccountPool', () => {
  it('recovers a rate_limited account after the TTL expires', () => {
    /* ... */
  });
  it.fails('must refuse to pick a disabled account as a fallback', () => {
    /* ... */
  });
});
```

The name = the sentence describing the expected behavior, not the function name.

---

## 8. Git & PR

### 8.1 Commit

Conventional Commits:

```
feat(pool): add least-inflight bias to round-robin
fix(translator): send message_start before the first chunk
docs(plan): add the PRD document
refactor(web): move filter state into the URL
test(compression): add a fail-open matrix test
chore(deps): bump drizzle to 0.45
```

**Scope** = the package/folder name. The message is in English, imperative, lowercase.

### 8.2 PR

- One PR = one purpose. If it contains two unrelated things, split it.
- The description contains: **what**, **why**, **how to test**.
- **Required** to check:
  - [ ] Boundary test green
  - [ ] Test suite green
  - [ ] All four states tested (if UI)
  - [ ] Light & dark tested (if UI)
  - [ ] Keyboard-only tested (if UI)
  - [ ] No new `style={{}}`
  - [ ] No new hardcoded color
- **Forbidden** to rewrite whole files in one PR. Surgical edits.
- **Forbidden** `--no-verify`.

### 8.3 Message Format

Commits and PRs end with an attribution line per the repository configuration.

---

## 9. Anti-Patterns (Forbidden)

Generally applicable, with emphasis drawn from prior-project experience:

| #     | Anti-pattern                                                                        | Reason                                                                        |
| ----- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| AP-1  | **Whole-file rewrite**                                                              | Loss of history; use surgical edits                                           |
| AP-2  | **Filter out tool messages**                                                        | Always keep tool + assistant tool_call                                        |
| AP-3  | **Automatic access-token deduplication**                                            | Causes unexpected sessions                                                    |
| AP-4  | **Send the `Authorization` header for Anthropic-Compatible if `apiKey` is present** | Auth conflict                                                                 |
| AP-5  | **Call `buildXRequest` twice**                                                      | Double-translation drops `tool_results`                                       |
| AP-6  | **Hand-edit auto-generated files** (index registry)                                 | Overwritten on regenerate                                                     |
| AP-7  | **A compression hook that can throw**                                               | Violates fail-open                                                            |
| AP-8  | **Silent fallback to direct egress** when the proxy pool fails                      | Identity leak                                                                 |
| AP-9  | **Silent reroute to another model**                                                 | The user did not consent; drop the control or replace the placeholder instead |
| AP-10 | **A home-grown SSE parser**                                                         | The AI SDK already provides one                                               |
| AP-11 | **Hardcode color/radius/duration**                                                  | Violates the design system                                                    |
| AP-12 | **Inline `style={{}}`**                                                             | Violates the design system                                                    |
| AP-13 | **Red test suite on a clean checkout**                                              | A poor quality signal                                                         |
| AP-14 | **Exceptions in the boundary test**                                                 | The boundary is law; move the type into contracts                             |
| AP-15 | **Copying restrictively-licensed code**                                             | See §9.2                                                                      |

### 9.2 License — Adoption Rules

| Source                                | Status                  | What is allowed                               |
| ------------------------------------- | ----------------------- | --------------------------------------------- |
| A private, unlicensed source          | PRIVATE / no license    | **Patterns only. Copying code is FORBIDDEN.** |
| open-webui                            | Branding clause         | **Patterns only.**                            |
| lobe-chat                             | Community License       | **Patterns only.**                            |
| chatbox                               | GPL-3.0                 | **Patterns only** (or avoid)                  |
| tldraw                                | Paid production license | **Patterns only.**                            |
| ComfyUI                               | GPL-3.0                 | **Patterns only.**                            |
| A1111                                 | AGPL-3.0                | **Patterns only.**                            |
| promptfoo                             | MIT                     | Code (as a dependency)                        |
| assistant-ui, `@lobehub/icons`        | MIT                     | Code (as a dependency)                        |
| streamdown (+ `@streamdown/*` plugin) | Apache-2.0              | Code (as a dependency)                        |
| Vercel AI SDK (`ai`, `@ai-sdk/react`) | Apache-2.0              | Code (as a dependency)                        |
| ToseaAI/llm-fingerprint-detector      | MIT                     | Code (with attribution)                       |
| modelprint, llm-verify                | MIT                     | Code (with attribution)                       |
| vivgrid/llm-fingerprinting            | No license              | **Patterns only.**                            |

**Rule:** every new dependency must pass a license check before it is added. The license **must** be compatible (MIT / Apache-2.0 / BSD). Strong copyleft (GPL/AGPL) may be used **only** as a separate, non-linked process, and even then it needs an ADR.

---

## 10. Dependencies

### 10.1 Adding a Dependency

Before adding, answer **all** of these:

1. Can the function already be achieved with what exists?
2. Is the license compatible? (§9.2)
3. Is the size proportionate to the benefit?
4. Is it actively maintained (a commit within the last 6 months)?
5. Does it not duplicate the role of an existing dependency?

If any answer is doubtful, **do not add it**. Write it yourself if it is small.

### 10.2 Approved Dependencies

**Backend:** `hono`, `@hono/zod-validator`, `drizzle-orm`, `drizzle-kit`, `pino`, `zod`, `undici`, `socks-proxy-agent`, `playwright`, `camoufox-js` (optional).

**Frontend:** `react`, `react-dom`, `react-router`, `@tanstack/react-query`, `zustand`, `tailwindcss`, `@radix-ui/react-*`, `lucide-react`, `recharts`, `react-markdown`, `remark-gfm`, `shiki`, `katex`, `mermaid`, `ai`, `@ai-sdk/react`, `assistant-ui`, `streamdown`, `@lobehub/icons`, `monaco-editor`, `@xyflow/react`, `react-konva`.

**Dev:** `typescript`, `vitest`, `@vitest/coverage-v8`, `msw`, `eslint`, `prettier`, `drizzle-kit`.

**Explicitly rejected:** `framer-motion`, `gsap`, `anime.js`, `shadcn/ui`, `next`, `prisma`, `trpc`, `recoil`, `antd`, `mantine`, `@mui/*`, `excalidraw`, `tldraw`, `fabric`.

### 10.3 Removing a Dependency

Removing a dependency is **always** welcome. A PR that removes a dependency does not need as strong a justification as one that adds.

---

## 11. Performance

| #   | Target                                                                                |
| --- | ------------------------------------------------------------------------------------- |
| P-1 | LCP <1.5s locally (NFR-4)                                                             |
| P-2 | Initial bundle <300KB gzip (NFR-9)                                                    |
| P-3 | Lazy-load every route                                                                 |
| P-4 | Prefetch on nav hover/focus                                                           |
| P-5 | Code-split per application (console/landing)                                          |
| P-6 | No synchronous blocking on the main thread                                            |
| P-7 | Images: client-side downscale before upload                                           |
| P-8 | Queries: explicit `staleTime`; **never** a default of 0 that triggers a refetch storm |

---

## 12. Documentation

### 12.1 Required

| File                                   | Contents                                                        |
| -------------------------------------- | --------------------------------------------------------------- |
| `README.md`                            | What, why, how to run, screenshot                               |
| `ARCHITECTURE.md`                      | System map, request flow, boundaries                            |
| `AGENTS.md`                            | Conventions for AI agents; anti-patterns; refer to CONTRIBUTING |
| `CONTRIBUTING.md`                      | This document                                                   |
| `docs/adr/NNNN-*.md`                   | One ADR per major architectural decision                        |
| `.env.example`                         | Every variable, with comments                                   |
| `apps/server/src/<folder>/<FOLDER>.md` | One document per top-level backend folder                       |

### 12.2 Comment Style

Comments explain **why**, not **what**. Code explains what.

```ts
// GOOD — explains the failure it prevents
// `flex: 1 1 auto` + min-height, not `height: 100%`:
// the shell column has no free space for a box that grows,
// so `height: 100%` would collapse the viewport state.
.state-viewport { flex: 1 1 auto; min-height: 220px; }

// BAD — restates the code
// set flex to 1 1 auto
.state-viewport { flex: 1 1 auto; }
```

**Do not** write comments that restate the function name. **Do not** write comments as a substitute for a good variable name.

### 12.3 Every ADR

Every decision D1–D17 in [PRD](../plan/PRD.md) requires an ADR in the format:

```
# NNNN — <Decision title>
Status: Accepted · Date: YYYY-MM-DD
## Context
## Decision
## Consequences
## Rejected alternatives
```

---

## 13. PR Checklist (Copy into the PR Description)

```markdown
## Summary

<!-- what and why -->

## Testing

<!-- how to verify -->

### Checklist

- [ ] Boundary test green
- [ ] Test suite green (`bun run test`)
- [ ] Typecheck clean (`bun run typecheck`)
- [ ] If UI: all four states (loading/empty/error/filled) tested
- [ ] If UI: light & dark tested
- [ ] If UI: keyboard-only tested
- [ ] If UI: 4 breakpoints tested (375/768/1280/1920)
- [ ] No new `style={{}}`
- [ ] No new hardcoded color/radius/duration
- [ ] No new dependency without a license check
- [ ] No new exceptions in the boundary test
- [ ] Documentation updated if needed
```
