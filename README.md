# rutekit

> Self-hosted AI router & gateway — one OpenAI-compatible endpoint, many providers behind it.

**Status: PHASE A–D complete.** A 27-page console, a Hono backend serving all 83 contract
paths, 1650 green tests, and a data plane verified against a real provider. What could not
be verified on the development machine is listed under [Roadmap](#roadmap) rather than
claimed.

---

## What This Is

`rutekit` aggregates many AI provider accounts behind **one OpenAI-compatible API
endpoint** (`/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/completions`,
`/v1/models`). Any client — a coding agent, an IDE extension, a CLI — can route requests
through it without knowing each provider's dialect.

What it adds over the routers that came before it:

- **A declarative provider registry.** A provider is a manifest, not a module: adding one
  means adding data, not code.
- **A translator with a pivot and a direct route.** Two dialects that are the same one are
  not re-rendered, so the fields the pivot does not model survive.
- **A real account pool.** Leases, cooldowns, quota tracking, and a Bayesian model probe
  decide which account takes a turn.
- **A Token Saver pipeline** whose savings are measured and reported per request, not
  estimated.
- **A full operator console**, including the surfaces most routers leave out: multi-variant
  benchmarking, video studio, and model-authenticity verification.

---

## Running It

Requires [Bun](https://bun.sh) 1.2+.

```bash
bun install
bun run dev
```

`bun run dev` starts **two things**: the server on `127.0.0.1:7331` and the console on
`http://localhost:5173`, which proxies `/console/api`, `/v1` and `/ws` to the server. Open
the console, finish the first-run wizard, and the instance is ready.

The console does **not** use mock data by default — it reads the server's database.
`VITE_MOCKS=on` turns on a mock layer as a shortcut, for working on the frontend without a
server or for separating rendering bugs from data bugs; it announces itself at boot so it
cannot be mistaken for a real console.

| Command                 | What it does                                                               |
| ----------------------- | -------------------------------------------------------------------------- |
| `bun run dev`           | Server + console, watch mode                                               |
| `bun run dev:server`    | Server only                                                                |
| `bun run dev:web`       | Console only (needs a server running)                                      |
| `bun run check`         | Typecheck + lint + test — the same gate CI runs                            |
| `bun run test:coverage` | Tests with the coverage gate (NFR-2: ≥85% lines across `apps/server/src`)  |
| `bun run ci`            | `check` + coverage + build — exactly what CI runs                          |
| `bun run build`         | Console into `apps/web/dist`, then a standalone binary into `dist/rutekit` |

**Configuration.** Every setting is a `RUTEKIT_*` variable; [`.env.example`](.env.example)
lists them all with comments. An instance started without a `.env` still comes up — it keeps
its database in `./data` and warns about the two secrets that were not filled in.
`rutekit init` writes a `.env` with both of them generated.

**Distribution.** A `rutekit` CLI (installer + starter), a standalone binary that embeds its
own console, and a non-root Docker image. See
[ADR-0037](docs/adr/0037-distribution.md).

---

## Core Decisions

| Area         | Choice                                    |
| ------------ | ----------------------------------------- |
| Runtime      | Bun                                       |
| Language     | TypeScript end-to-end, fully strict       |
| Backend      | Hono                                      |
| Database     | SQLite via Drizzle, numbered migrations   |
| Frontend     | React 19 + Vite + Tailwind 4 + CSS tokens |
| Components   | Radix UI primitives, styled in-house      |
| Automation   | Node subprocess + Playwright              |
| Distribution | `rutekit` CLI, standalone binary, Docker  |

Two constraints shape the entire architecture:

1. **Frontend and backend are separated, and a machine enforces it.** A test walks the
   import graph and fails if `apps/web` touches `hono`, `drizzle`, `node:*` or Playwright —
   or if `apps/server` touches React. `packages/contracts` is the only bridge.
2. **Contracts first.** Types and Zod schemas are written in `packages/contracts` before the
   implementation exists, and every route validates its input against those schemas.

Details: [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Documentation

**Start here:** [docs/README.md](docs/README.md)

| Document                                               | Contents                                                 |
| ------------------------------------------------------ | -------------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)                     | How the pieces fit together, and why                     |
| [AGENTS.md](AGENTS.md)                                 | Working rules for this repo, including traps already hit |
| [docs/plan/PRD.md](docs/plan/PRD.md)                   | The full product requirements                            |
| [docs/plan/ROADMAP.md](docs/plan/ROADMAP.md)           | The staged Phase A→D plan, with gates                    |
| [docs/plan/RULESET.md](docs/plan/RULESET.md)           | The hard rules (read before writing code)                |
| [docs/plan/CONTRIBUTING.md](docs/plan/CONTRIBUTING.md) | Coding and contribution guidelines                       |
| [docs/adr/README.md](docs/adr/README.md)               | 38 Architecture Decision Records                         |

Every top-level folder in `apps/server/src` has its own README explaining what it owns and
which invariants it must not break.

---

## Roadmap

| Phase | Contents                                                                   | Status                             |
| ----- | -------------------------------------------------------------------------- | ---------------------------------- |
| **A** | Monorepo, `packages/contracts`, design system, shell, MSW, boundary test   | ✅ complete                        |
| **B** | 26 frontend pages complete against mock data                               | ✅ complete — confirmed by the user |
| **C** | Hono backend: registry, translator, pool, automation, chat, studio, system | ✅ complete (C1–C14)               |
| **D** | Tests, operations, distribution, documentation, polish                     | ✅ complete (D1–D5)                |

**What is not done, stated openly:**

- **Manual keyboard testing** — a person has to press Tab through 27 pages and watch. An
  agent cannot do that, so it is not claimed.
- **Firefox has never run this console.** The cross-browser pass covers Chromium and WebKit;
  Firefox could not be launched on the development machine at all (`uv_spawn` fails for both
  cached builds), so it is untested rather than passing.
- **Control borders sit at 1.3–2.1:1**, below the 3:1 WCAG 1.4.11 asks for. The palette is a
  designed one with documented tuning; raising it changes how every input looks, and that was
  deferred. The numbers are pinned by a test so they cannot drift unnoticed.
- **The Docker image has never been built to completion.** This development machine has no
  usable Docker daemon; the `bun install` step inside the image has been verified against a
  real Linux builder, but the container has never run.
- **`.github/workflows/ci.yml` has never run** — the GitHub repository was removed before it
  could. The script (`bun run ci`) passes locally.
- **The data plane has been verified against one real provider** (a non-streaming turn,
  streaming with a 942 ms TTFT, 400 models fetched). The second provider tried rejected its
  own credentials, so cross-provider streaming is untested.

**What was measured, rather than asserted:** LCP is **224 ms median** against the production
console (budget 1500 ms), and all 25 routes mount and render in **both Chromium and WebKit**
with no console errors. Both numbers come from a real headless browser driven through
Playwright — the Browser pane cannot paint, so it can measure neither.

Full detail: [docs/plan/ROADMAP.md](docs/plan/ROADMAP.md)

---

## Pages (27)

**Overview** Dashboard · Usage & Metrics · Console Log
**Providers** Catalog · Detail · Accounts · Quota Management
**Routing** Combos & Routes · Model Mapping · Filter Rules · Token Saver · API Keys
**Automation** Automation · Logs · Proxy Pool · SMS Providers
**Tools** Chat · Studio · Benchmark · Model Verification · Tools · CLI Tools
**System** Customization · Settings
**Auth** Login · Setup

---

## License

**rutekit itself: [MIT](LICENSE).** Use it, change it, sell it — with attribution.

### Dependencies

Every third-party dependency's license is checked before it is added
([CONTRIBUTING §9.2](docs/plan/CONTRIBUTING.md)). The ones that shape the architecture: Bun,
Hono, Drizzle, Zod, React, Vite, Tailwind, Radix UI, Playwright, and promptfoo — all
permissive.

---

## Contributing

Read [docs/plan/RULESET.md](docs/plan/RULESET.md) first — one page covering the rules that
are not negotiable. Then [docs/plan/CONTRIBUTING.md](docs/plan/CONTRIBUTING.md) for the
reasoning behind them, and [AGENTS.md](AGENTS.md) for the practical working rules in this
repo.
