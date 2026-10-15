# `rutekit` documentation

## Contents

| Folder                  | Contents                                     | Status       |
| ----------------------- | -------------------------------------------- | ------------ |
| [`plan/`](plan/PRD.md)  | PRD, roadmap, contribution guide, ruleset    | **complete** |
| [`adr/`](adr/README.md) | Architecture Decision Records (38 decisions) | **complete** |

## Where To Start

**If you want to understand the product:**

1. [plan/PRD.md](plan/PRD.md) — the full requirements

**If you are going to write code:**

1. [plan/RULESET.md](plan/RULESET.md) — read this first, one page
2. [../ARCHITECTURE.md](../ARCHITECTURE.md) — how the pieces fit together
3. [../AGENTS.md](../AGENTS.md) — working rules and traps that have already bitten
4. [plan/CONTRIBUTING.md](plan/CONTRIBUTING.md) — the full guide, with reasoning
5. [plan/ROADMAP.md](plan/ROADMAP.md) — where the work stands today

**If you want to know why a decision was made:**

1. [adr/README.md](adr/README.md) — index of all 38 decisions

## One-Paragraph Summary

`rutekit` is a self-hosted AI router & gateway: one OpenAI-compatible endpoint that
aggregates many provider accounts behind it. It is built end-to-end in TypeScript, with the
frontend finished in full before the backend, and with the frontend/backend split enforced by
a test rather than by convention. On top of the routing core it adds a set of surfaces most
routers leave out: multi-variant benchmarking, a video studio, and model-authenticity
verification.

All four phases are complete. See [ROADMAP](plan/ROADMAP.md) for the plan and for the work
that is still open.

## Full Document Map

```
docs/
├── README.md                          (this document)
├── plan/
│   ├── PRD.md                         product requirements
│   ├── ROADMAP.md                     staged plan, A→D
│   ├── CONTRIBUTING.md                coding & contribution guidelines
│   └── RULESET.md                     hard rules + checklist
└── adr/
    ├── README.md                      ADR index
    └── 0001..0038-*.md                architecture decisions
```

Outside `docs/`, two top-level documents complete the picture:
[ARCHITECTURE.md](../ARCHITECTURE.md) (how the system is put together) and
[AGENTS.md](../AGENTS.md) (practical working rules and traps already found). Beyond those,
every top-level folder in `apps/server/src` has its own README.

## Documentation Rules

- Documents in `plan/` are the **source of truth** for requirements and rules.
- Documents in `adr/` are **decision records** — historical, binding until superseded.
- If `plan/` and `adr/` disagree, **`plan/CONTRIBUTING.md` wins** on matters of process, and
  **the newer ADR wins** on specific technical decisions.
