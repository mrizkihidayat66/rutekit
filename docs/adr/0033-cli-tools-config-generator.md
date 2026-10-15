# ADR-0033 — CLI config generator: text to copy, a base URL the operator owns, and the catalog as data

Status: **Accepted** · Date: 2026-10-14 · Related decisions: FR-2.4, ADR-0018, ADR-0032

## Context

C13c is the last item of PHASE C: **a config generator for coding clients** — show the
operator what to write in the config of Claude Code, Codex, Cline, OpenCode, Continue, and
similar clients so that the client points at rutekit instead of at the vendor.

One thing is immediately visible: **there is no CLI Tools page among the 26 pages of
the PRD**. The frontend that was confirmed complete has no place for this, and that
makes C13c not an ordinary PHASE C group — it is mostly PHASE B work.

Comparable tools in this space all ship this feature, and they shape it uniformly: a
CLI-tools page in the console that knows which clients are installed and writes their
config files. That uniformity is precisely what has to be rejected — the shape depends
on the console running on the operator's machine, which is an assumption rutekit's
console cannot make.

Four things are not answered by the contract itself.

## Decision

**The output is text to copy, not a file that gets written; the base URL is a field
the operator fills in themselves; the catalog is data in `packages/contracts` with no
backend route; and a format that has not been verified says so in the UI.**

### 1. Text, not a file — and it is not a smaller version

The comparable tools run their console on the operator's machine. That is what lets
them **detect installed clients and write their config files**: the console is a local
application, and its home directory is the home directory of the person using it.

rutekit's console is a web page against a server that may be on a completely different
host. It cannot see anything on the operator's machine, and must not be able to write
into it. So the output is text, and the operator pastes it.

**This is a smaller feature and a better one at the same time.** A page that can
rewrite `~/.codex/config.toml` is a page that, if compromised, gives an attacker the
ability to write to the machine holding every provider key. A page that only produces
text has no such ability — and text the operator sees before pasting is one layer of
checking that the write-automatically version lacks.

What is lost: detection. The operator has to know which client they use. That is an
accepted cost, and the page covers it with two generic entries.

### 2. The base URL belongs to the operator, and its default is the browser origin

**The server cannot answer this question.** `RUTEKIT_HOST` defaults to `127.0.0.1`,
and `127.0.0.1:7331` is exactly the value that does **not** work for the clients this
page exists to configure: a coding agent on a laptop pointing at `127.0.0.1` means
"that laptop", so an operator reaching rutekit over the LAN would get a client talking
to nothing at all, with no error saying why.

So the field is editable, and its default is **`window.location.origin`** — the address
that provably works from wherever the operator is standing, because the page they are
reading was loaded from it.

That is still only a default. Behind a reverse proxy, the console origin can differ
from the API origin, and nothing can know that from inside the browser. That is why the
field's description says so, instead of presenting its value as fact.

### 3. `/v1` is the most dangerous part, so it is declared per client

The most common way a config that looks right fails is the `/v1` suffix: some clients
take the origin and add their own path, others want `/v1` already included. **Nothing
can infer which**, so it is declared per catalog entry (`baseUrlSuffix: 'none' | 'v1'`)
instead of guessed at render time.

The value for Claude Code is **verified, not remembered**: the SDK the CLI uses builds its
request as `baseURL + '/v1/messages'`, so the base URL must be the origin alone. A
`/v1` there sends every request to `/v1/v1/messages`.

That verification also turned up two things that went into the snippet:

- **The token is sent as `Authorization: Bearer`, not `x-api-key`.** Checked against
  `apps/server/src/ingress/api-key-guard.ts`: the guard already reads
  `Authorization: Bearer`, so the request matches as-is. This is a coincidence that
  saves this feature from being "a snippet that looks right and does not work" — and
  if the guard only accepted `x-api-key`, the entire Claude Code entry would be wrong without
  anyone knowing.
- **With both a token _and_ a key exported, the CLI sends both headers**, and which
  header the gateway honors becomes the gateway's decision. The snippet therefore
  closes with `unset ANTHROPIC_API_KEY`.

### 4. The catalog is data in `packages/contracts`, with no backend route

One table (`CLI_TOOLS`) and one pure function (`snippetsFor`) in
`packages/contracts/src/entities/cli-tools.ts`, for the same reason as the provider
manifest (ADR-0018): a statement about how other software is configured is not a
rendering concern, and putting it in `apps/web` would make it unreachable from
anywhere — including the CLI whose sibling work will ship later.

**There is no backend route.** There is nothing to ask the server: the catalog is
static and the base URL is precisely the value that must not come from the server. A
route wrapping the two would be a route whose only content is static data and one
value that is wrong for the most important case.

The consequence is recorded honestly: **C13c closes a PHASE B gap, not a new backend
addition.** It is written in the ROADMAP as C13c with that note, and the PRD grows
from 26 pages to 27.

### 5. The client list is short on purpose, and the rest is two generic entries

Six named clients (Claude Code, Codex, Cline, Continue, OpenCode) plus two generic entries —
"OpenAI-compatible" and "Anthropic-compatible" — describing rutekit's own two surfaces.

**Not one of those clients is installed in this development environment**, so each
named client's file format is written from knowledge of that client and **has not been
run**. Growing the list to twenty would mean growing the list of formats that are not
checked, and on a feature whose entire output is config files, one wrong key means a
client that quietly does not work.

So the cost is paid elsewhere: two generic entries carry the clients not on the list.
The values are the same — base URL, key, model — and only their spelling differs, so an
operator of another client reads the generic entry and then checks their client's
documentation for the key names.

`formatVerified` is **an admission, not a quality signal**: `true` only where the
snippet's shape was checked against the client's documentation or source, `false` where
it was written from knowledge and has not been run. The flag is shown to the operator,
not stored silently — a subtly wrong snippet fails in a way that looks like rutekit
being broken, and the operator has no way to tell the two apart.

### 6. The three values live in component state, not in the URL

Unlike almost every other control in this console (RULESET R6.5/R6.6, filters and tabs
in the URL), the three values on this page do **not** go into the query string.

The reason is one: **one of them is a secret.** An API key in a query string lands in
browser history, in server logs, and in whatever the operator pastes the link into. The
other two values follow it because splitting one field into the URL and two into state
is a stranger shape than keeping all three in one place.

What is lost: this page cannot be linked with the values pre-filled. That is an accepted
cost, and a small one — there are three values, and re-entering them takes a few
seconds.

### 7. `datalist`, not a closed picker

The model field uses a `<datalist>` populated by `useModelIds()` — a suggestion, not a
closed list.

The models that can be routed are not only those in the catalog: an alias the operator
defined also works, and it is not in the catalog. A closed picker would make this page
reject the very values the operator most wants to use.

## Consequences

**Positive**

- FR-2.4 has a pasteable entry point: six clients plus two generic entries.
- The page cannot write anything to anyone's machine — a class of vulnerability that
  does not exist, rather than one that is mitigated.
- The most commonly wrong `/v1` fact is correct for Claude Code, and verified against its SDK
  rather than remembered.
- The catalog is data, so a CLI arriving later can use it without copying this table
  again.
- The tests hold back four classes of mistake at once: an entry without a snippet, an
  unsubstituted placeholder, JSON that does not parse, and `/v1` on the Messages
  surface.

**Negative / risk**

- **Five of the seven formats have never been run.** Codex, Cline, Continue, OpenCode,
  and Claude Code `settings.json` are written from knowledge of those clients. Only the generic
  entries have a shape that can be checked from this repository, and only Claude Code is
  verified against its client source. The page says so, but still: this is the code most
  likely to be wrong in all of PHASE C.
- **There is no client detection, and there never will be** as long as the console is a
  web page. The operator has to know which client they use.
- **The client list cannot grow without a verification cost.** Every new entry is a new
  format that might be wrong, and no test can catch it — the tests check the _shape_,
  not the _correctness_.
- **There is no documentation deep link.** `docsUrl` deliberately points at the client's
  documentation root, because a deep link into a documentation tree is a URL that rots
  quietly. That means the operator sometimes has to find the relevant page themselves.
- **The key in component state means it is in the tab's memory** until the page is
  left. There is no "clear" button, and nothing stops the operator from leaving that tab
  open.
- **The default model is `gpt-4o-mini`** — a real model with a reasonable price, but
  still an invented choice: an install without that provider will produce a snippet
  pointing at a model that cannot be routed until the operator changes it.

## Rejected Alternatives

| Alternative                                 | Rejected because                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| Write config files to the operator's disk   | The console is a web page; the client machine may be a different host        |
| Auto-detect installed clients               | A browser cannot see the filesystem; only a local application can            |
| Base URL from `RUTEKIT_HOST`/`PORT`         | `127.0.0.1` means "the client machine", not "the rutekit machine"            |
| Base URL from `RUTEKIT_CONSOLE_ORIGIN`      | Right for OAuth, wrong here — it is the console origin, not the API origin   |
| One global `/v1` suffix                     | Some clients add their own path; it cannot be inferred                       |
| A broad client list (~20)                   | Grows the list of formats that cannot be checked                             |
| Generic snippets only                       | Almost no added value; no reason to open this page                           |
| A backend route for catalog + origin        | Wraps static data and one value that is wrong for the most important case    |
| Keeping all three values in the URL         | An API key in the query string lands in history and logs                     |
| A closed model picker                       | An operator-defined alias is not in the catalog                              |
| Hiding `formatVerified`                     | A subtly wrong snippet looks like rutekit being broken                       |
| Hiding entries that are not yet verified    | That client's operator gets nothing, even though the three values are right  |
| Deep links into client documentation pages  | URLs that rot quietly; a root that still works is worth more                 |
| Reusing the `clients.ts` list from API Keys | That is denylist label vocabulary, not a list of clients with config formats |
