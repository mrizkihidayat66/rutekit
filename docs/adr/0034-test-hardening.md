# ADR-0034 — Test hardening: an honest coverage provider, tests that sweep the matrix, and tests that find gaps

Status: **Accepted** · Date: 2026-10-14 · Related decisions: NFR-2, A1, ADR-0003

## Context

D1 is the first group of PHASE D (Hardening), and the roadmap asks for six things:
coverage ≥85% lines on `apps/server/src` (NFR-2), a data-driven translator matrix test
(A1), a contract test for endpoint ↔ schema, a parity test for mirror/usage dimensions/
provider list/icon map, a boundary test that stays green, and isolated DB tests.

What the roadmap does not answer is how those five tests are written, and one question
that turned out to be far more important than it looks: **whether the coverage number
can be trusted at all.**

## Decision

**Move to the istanbul coverage provider because v8 under Bun reports files it failed
to convert as 100% covered; sweep the matrix instead of writing a case per pair; and
let the contract test go red when it finds a missing route.**

### 1. The coverage number lies, and that was found before it was trusted

`bun run test --coverage` reports **92.38%** lines for `apps/server/src`. That number
is wrong.

The `@vitest/coverage-v8` provider **fails to convert 78 of 174 files** under Bun, and
a file that fails to convert is **reported as 100/100/100/100** — 59 of the 65 files
that were checked were exactly that. Including `system/backup.ts`, which was written in
C13b with a branch known to be untested.

The cause is the runtime, not the code. Same project, same tests:

| Runtime | Conversion failures                  | Reported number                   |
| ------- | ------------------------------------ | --------------------------------- |
| Bun     | 11 (contracts project) / 78 (server) | 92.38% lines                      |
| Node    | 0                                    | — (the server cannot run on Node) |

The server cannot run on Node at all: it uses `Bun.password`, `hono/bun`, and
`bun:sqlite`. So "run it on Node" is not an option, and that means the only path is to
swap the provider.

With `@vitest/coverage-istanbul`: **0 conversion failures**, and the number moves from a
fake 92.38% to an honest **86.37% lines / 74.23% branch**.

**Why this is an architecture decision and not a tooling choice.** A CI gate built on
the v8-Bun number would pass in a repository whose coverage is far lower than it claims
— and worse, it would **report a file with no tests as a perfect file**, which means
every time someone adds a file without tests, the number goes up. A gate that rewards
the very behavior it should prevent is worse than no gate.

The threshold lives in the root `vitest.config.ts`, not in the server project, because
its `include` is `apps/server/src` and nothing else: NFR-2 is about the server, and
including the worker, the benchmark provider, and the packages would let one
well-covered package hide an uncovered route.

The threshold is on **lines**, because that is what NFR-2 names. Branch and function are
still reported — a number worth seeing is worth printing — but they are not a gate, and
hanging a gate on a number nobody chose would mean inventing a requirement.

### 2. The matrix test sweeps, rather than writing a case per pair

`matrix.test.ts` does not name a single pair. It reads `clientSurfaceSchema` and
`wireFamilySchema`, crosses them into sixteen pairs, and for each pair runs the whole
pipeline: ingest → route → encode → decode → render.

The existing tests (`codecs`, `ingest`, `render`) write a case per behavior, and that is
what they do well. What they cannot do is **notice a combination nobody has ever
written**: adding a fifth family would leave four or twenty pairs untested, and nothing
would fail — the suite would stay green while that new dialect had never once been run
end to end.

The last step is what ties this package to the contract: the rendered body must pass its
own surface schema in `packages/contracts`. A family that renders a body its own schema
rejects fails here, in the package that produces it, not at the edge as an
inexplicable client error.

**The claim "a new family is automatically covered" is tested, not claimed.** Adding
`'mistral'` to the enum immediately fails 12 new tests because that family has no codec
yet. Without that step, the test would only mean "83 tests green".

The assertions are **structural**, not about content — and that is not a weakness.
Writing them the first time surfaced a wrong assumption: I asserted the model had to be
in the _body_, and Google puts it in the **path**
(`/v1beta/models/gemini-1.5-pro:generateContent`), which is indeed Gemini's behavior.
The assertion became "the model reaches the provider somewhere", because where is the
family's business.

### 3. Parity is enforced from both sides against the contract, not one side to the other

Frontend and backend must not read each other — the boundary test forbids it in both
directions — so parity cannot mean "one side checks the other". What it can mean:
**each side is held to the contract**, and a list that diverges is caught on whichever
side it diverges.

Four lists that are copied, and why each matters:

| List             | Where                                           | Why it breaks silently                                                                              |
| ---------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Usage dimensions | `BREAKDOWN_COLUMN` (server), `DIMENSIONS` (web) | `BREAKDOWN_COLUMN` is indexed by dimension: a missing one becomes `undefined`, and the query breaks |
| Icon map         | `ICONS` (web)                                   | An unknown slug falls back to a neutral box — which looks like a design choice                      |
| Mock domains     | `MOCK_DOMAINS` ↔ barrel (web)                   | A domain without a handler: flipping to the real server becomes a no-op that looks like success     |
| Provider list    | registry (server)                               | Already guarded by `providers-index.test.ts`; slug shape and `get()` resolution were added          |

The most important is the usage dimensions, because its failure is not a wrong number
but a query that cannot be built. That is why the test **pushes every dimension from the
enum through the real repository** instead of reading its map: the map is private, and
what the operator experiences is the query.

### 4. The contract test found the PHASE C gap, and is left red

`apps/server/test/contract.test.ts` runs **every console GET without parameters** against
the real application and validates its body against the schema the contract declares for
that path.

It found that the server registers **81 of 83** `consolePaths`, and the two missing ones
are **the entire Token Saver console backend**: `GET`/`PATCH /token-saver` and
`GET /token-saver/savings`. The Token Saver page **404s against the real server**; it
only works against the mock, whose handlers are complete.

Two levels of difficulty, and that is why the gap is not closed here:

- **Config** — small. `createTokenSaverSettings` already exists with `read()`/`write()`,
  `deps.tokenSaver` is already in `AppDeps`, and `tokenSaverConfigUpdateSchema` is
  already in the contract.
- **Savings** — a feature. `packages/compression` already produces `StageReport[]` with
  exactly the fields the schema asks for, but **the recorder never stores them**, so it
  needs a migration + recorder change + aggregation + route.

**The test is deliberately left red.** Adding the two routes to the "not
validated" table would make the suite green while hiding exactly the gap this test was
created to find — and that is the pattern the file's header names as one to avoid. Red
means: there is a route the contract promises and the server does not serve. The gap is
recorded as **C14** in the ROADMAP.

One note on the table: it is hand-written, transcribed from `apps/web/src/data/*` — where
the mapping already exists and is already authoritative — and its first test ensures the
table stays complete, so a route added later cannot quietly go uncovered.

### 5. Test isolation is held by an assertion, not by coincidence

Every server test gets its own database and data directory. That is true **by
construction**, not because anyone checks it: `:memory:` happens to be per-call, and
`mkdtempSync` happens to be unique.

"Coincidence" is the part worth pinning. A change to `makeServer` that pointed all tests
at one on-disk database would still be green when run alone and would become an
order-dependent flake under `--shuffle` — and its failure would show up as a different
test failing intermittently, one of the most expensive kinds of bug to hunt.

### 6. One resource leak was fixed because the provider is honest

The istanbul provider surfaced what v8 hid: `RangeError: Cannot use a closed database`,
from a warmup check-in still running when the test server had already closed its
database.

Two defects, both real in production:

- `warmup.stop()` only did `clearInterval` — a sweep **already in flight** keeps running.
  `main.ts` calls `warmup.stop()` before `persistence.close()`, with the entire drain
  timeout in between, so the same window exists in production.
- The test helper never called `warmup.stop()` at all.

The fix is a generation counter read before every database touch. The "stop" behavior
also becomes part of what an outcome means: a probe that was stopped does not write
`transient`, because it never reached the provider and recording it would raise the
failure streak for an account with no problem.

**The first test for this bug passed even with the guard removed** — it tested nothing.
It was replaced with a genuinely changing observable (401 → account `banned`, not a field
that happened to already be null), and then all three guards were shot down one by one.

## Consequences

**Positive**

- NFR-2 is now measured with a trustworthy number, and the gate rejects a drop (tested by
  raising the threshold to 99%).
- A new family or surface is automatically covered, and that is proven by mutation.
- The four copied lists are guarded on the side where they diverge, not in one place that
  has to know everything.
- **The contract test found a feature missing from PHASE C** — which is exactly its job.
- One resource leak on the shutdown path is fixed.
- Test isolation stops being a coincidence.

**Negative / risk**

- **The suite is red, and will stay red until C14 is done.** That is deliberate, but it
  means `bun run check` is not green — and a gate that stays red too long stops being read.
- **A sharper consequence: while the suite is red, the coverage gate does not run at
  all.** Vitest does not write a coverage report when a test fails — so `bun run
test:coverage` now exits without a table and without evaluating the threshold. The gate
  itself works (verified: 86.39% lines, threshold passes, and raising it to 99% makes it
  red), but it is only evaluated when the whole suite is green. Until C14 is done, **NFR-2
  is not machine-enforced** — and that is a bigger consequence than "red in the terminal".
- **Coverage of 86.39% is only 1.39 points above the 85% threshold.** The margin is thin,
  and a new file without tests will hit it faster than it looks.
- **The contract test table is hand-written.** `apps/web/src/data/*` is its source, and
  nothing forces the two to agree — only a completeness test ensuring no route is
  _missing_ from the table.
- **The contract test only sweeps GETs without parameters.** A parameterized route needs a
  real id, and that is per-feature test work; so the coverage is broad but not deep.
- **The icon-map parity is checked against a fixture, not the registry.** The fixture is
  the console's mirror of the registry, and both use the same 28 slugs today, but nothing
  enforces that — the web side must not see the registry.
- **`PROVIDER_ICON_SLUGS` has one slug no catalog uses.** Not a bug (a fallback glyph for
  BYOK), but it means "catalog ⊂ map" rather than "catalog = map", and that is a
  difference that is easy to misread.
- **`it.fails`, quarantine, and a "known missing" table were all rejected** for the
  token-saver gap. That is a conscious decision that makes the suite red; the alternative
  is green but a lie.

## Resolved Since

**C14 closed the gap this ADR was written around.** `GET`/`PATCH /token-saver` and
`GET /token-saver/savings` were built, so the contract test has no red case left, the suite
is green, and the coverage gate is evaluated again.

The figures in the section above are the ones measured during D1 and are kept as written,
because they are the record of what was found and why the test was left red — not a
description of the current state. Coverage has moved on since: it is now **87.02% lines /
74.66% branches**, and the suite is **84 files and 1650 tests**. See ADR-0035 for the Token
Saver work itself.

## Rejected Alternatives

| Alternative                                    | Rejected because                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Keep v8, add an anti-lying gate                | With 78 files failing today, that gate is immediately red and cannot be fixed from the config side |
| Run the server tests on Node                   | The server uses `Bun.password`, `hono/bun`, `bun:sqlite` — 36 test files fail                      |
| Remove the coverage gate                       | NFR-2 stops being machine-enforced, and the fake number is what hid this problem                   |
| Threshold in the server project                | `include` must be `apps/server/src` only; a well-covered package would hide an uncovered route     |
| Gate on branch and function too                | Invents a requirement nobody chose                                                                 |
| Write matrix cases per pair                    | Cannot notice a combination nobody has ever written                                                |
| Matrix assertions on content, not structure    | Copies the per-feature tests' work, and invents assumptions about one family                       |
| One parity test that sees both sides           | The boundary test forbids it in both directions                                                    |
| Icon parity against the registry               | The registry exists only on the server; the web side must not see it                               |
| Quarantine the two token-saver routes          | The "filter that hides the gap" pattern the file header names as one to avoid                      |
| `it.fails` for the missing routes              | The signal is inverted from what people normally read                                              |
| Build the Token Saver backend inside D1        | Feature work with a migration, slipped into a "write tests" task                                   |
| Leave test isolation as a coincidence          | Order flake is the most expensive bug to hunt                                                      |
| Warmup guard only in `checkIn`                 | `stop()` during an `await` mid-probe is a case that exists                                         |
| Warmup test on a field that happens to be null | Passed even with the guard removed — proven when shot down                                         |
