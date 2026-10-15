# rutekit

Self-hosted AI router and gateway. One OpenAI-compatible endpoint in front of many provider
accounts.

## What It Is

rutekit aggregates your provider accounts behind a single API, so a client that speaks one
dialect can reach every model you have without knowing how each provider differs. It serves
the five surfaces an OpenAI-style SDK already uses:

| Path                   | Surface            |
| ---------------------- | ------------------ |
| `/v1/chat/completions` | Chat completions   |
| `/v1/messages`         | Messages           |
| `/v1/responses`        | Responses          |
| `/v1/completions`      | Legacy completions |
| `/v1/models`           | Model listing      |

Point a client at rutekit instead of a provider and it keeps working. Streaming, tool calls,
vision, and reasoning blocks are translated between dialects, and a pair whose dialects
already match is passed through untouched rather than re-encoded.

Behind the endpoint: a declarative provider registry where a provider is data rather than
code, an account pool that leases accounts and tracks quota, a compression pipeline whose
savings are measured per request, and telemetry with retention.

## Quick Start

Requires [Bun](https://bun.sh) 1.2+.

```bash
bun install
bun run dev
```

That starts two processes: the server on `127.0.0.1:7331` and the console on
`http://localhost:5173`. Open the console, finish the first-run wizard, and add a provider
account.

## Using It

Create an API key in the console under **Routing → API Keys**, then point a client at the
server:

```bash
curl http://127.0.0.1:7331/v1/chat/completions \
  -H "Authorization: Bearer rk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Say PONG and nothing else."}]
  }'
```

The same key works for any OpenAI-compatible client — set its base URL to
`http://127.0.0.1:7331/v1` and its API key to the one you minted. Requests are resolved
against model mappings, aliases and combos before a provider is chosen, so the `model` field
may name an alias or a combo rather than a model.

## Configuration

Every setting is a `RUTEKIT_*` environment variable, and [`.env.example`](.env.example)
documents all of them. Two secrets are required — `RUTEKIT_ENCRYPTION_KEY` encrypts stored
provider credentials and `RUTEKIT_AUTH_SECRET` signs sessions:

```bash
bunx rutekit init
```

`rutekit init` writes a `.env` with both generated. An instance started without one still
comes up, keeping its database in `./data` and warning about the secrets it is missing.

## Deployment

| Method        | Command                                       |
| ------------- | --------------------------------------------- |
| Console + API | `bun run dev` (development)                   |
| Standalone    | `bun run build` → `dist/rutekit`              |
| Container     | `docker build -t rutekit .`                   |
| CLI           | `bunx rutekit init` then `bunx rutekit start` |

The standalone binary embeds the console and needs no other files. The container runs
non-root with `tini` as PID 1. See [ADR-0037](docs/adr/0037-distribution.md).

## Documentation

| Document                                     | Contents                                          |
| -------------------------------------------- | ------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)           | How the pieces fit together, and why              |
| [docs/plan/ROADMAP.md](docs/plan/ROADMAP.md) | The staged build plan and what is still open      |
| [docs/plan/PRD.md](docs/plan/PRD.md)         | The full product requirements                     |
| [docs/adr/README.md](docs/adr/README.md)     | Architecture Decision Records                     |
| [docs/plan/RULESET.md](docs/plan/RULESET.md) | The rules that are not negotiable                 |
| [CONTRIBUTING.md](CONTRIBUTING.md)           | How to contribute                                 |
| [SECURITY.md](SECURITY.md)                   | Reporting a vulnerability, and the security model |
| [AGENTS.md](AGENTS.md)                       | Working rules for AI agents and humans            |

Each top-level folder in `apps/server/src` has its own README describing what it owns and
which invariants it must not break.

## Development

| Command                 | What it does                                      |
| ----------------------- | ------------------------------------------------- |
| `bun run dev`           | Server and console, watch mode                    |
| `bun run check`         | Typecheck, lint and test — the definition of done |
| `bun run test:coverage` | Tests with the server coverage gate               |
| `bun run build`         | Console, then the standalone binary               |

The frontend and backend are separated by a test that walks the import graph:
`apps/web` may not touch Hono, Drizzle, `node:*` or Playwright, and `apps/server` may not
touch React. `packages/contracts` is the only bridge between them.

## License

[MIT](LICENSE). Use it, change it, sell it — with attribution.
