# ADR-0024 — Automation credential pools: proxy and SMS

Status: **Accepted** · Date: 2026-10-13 · Related decisions: FR-5.x, SEC-2, SEC-4

## Context

C7 opened with two questions that had to be answered before a single browser ran:
**from where** a bulk import exits, and **with what number** a registration creates an
account.

Both are things the operator buys and pastes into rutekit as a list: residential
proxies from one vendor, SMS activation keys from another. Both also have the same
shape — a set of credentials used in turn, where one dead entry must not stop the
batch — so both raise the same design questions:

1. **How the credentials are stored.** A proxy URL carries `user:pass` in its
   authority, and an SMS key is a bearer token. Both are credentials that must be
   written once and never read back.
2. **What "health" means for an entry.** A proxy just pasted in and a proxy that has
   been checked and failed are two different facts.
3. **How deep the checking goes.** Is health derived from the address, or measured?
4. **How one broken line is treated.** A two-hundred-line paste usually has one
   defective line.

C7a answers all four. What is **not** here is anything that opens a browser: jobs,
workers, the stdio protocol, and manual hand-off are C7b, and the browser driver is
C7c.

## Decision

**Two tables with the same shape — encrypted, write-only credentials; health that
only ever means what was measured; probes that actually call; and an import that
reports per line.**

### 1. Write-only credentials, with the same `SecretBox`

The `credential_envelope` in both tables uses the same `SecretBox` as
`provider_accounts` (R5.10, SEC-2). The read model carries `hasAuth` for a proxy and
`keyHint` (`first4••••last4`) for an SMS key — a boolean and a hint, not a secret.

`keyHint` is **stored** next to the envelope rather than derived from it. Deriving it
would mean decrypting on every list read, a read path that has to hold the box for a
value that does not change once the key is set.

The repository never holds the box. Decrypting is a decision about whether a
credential is still usable, and that belongs to the prober — the same rule as
`provider-accounts.ts` and `pool/`.

### 2. `untested` is a state, not a verdict

`health` defaults to `untested` and `last_checked_at` stays null until a probe
actually runs. The page distinguishes "never checked" from "checked and failed",
because an operator who reads "dead" on a freshly pasted proxy would discard an entry
that may be perfectly fine.

**The timestamp is reset along with the verdict.** When a proxy's address is changed,
health returns to `untested` **and** `lastCheckedAt` returns to null — one write, not
two. A fresh `lastCheckedAt` next to `untested` would display a check that never
happened. This is not hypothetical: it was a bug caught by a test, and it is why
`checkedAt` is part of `ProxyCheckWrite` rather than a separate argument.

The same reasoning applies to rotating an SMS key: the old verdict is about a
different key.

### 3. Health is measured, not derived

A proxy probe **actually makes a request through that proxy** and measures how long it
took. No health is guessed from the address, because this page exists to be a basis
for decisions: an operator who reads "healthy" and then watches their batch fail has
been lied to by the page.

**Bun's `fetch` has a native `proxy` option**, so there is no agent to install and no
socket to wire up by hand — and because it is the same `fetch` the server uses, a
proxy that cannot carry a request here is a proxy that cannot carry a worker's
request.

**Three verdicts, not two.** Under 1.5 seconds `healthy`, under 5 seconds `slow`,
otherwise or on failure `dead`. A proxy that answers in 900 ms is neither dead nor
healthy: it works, and a batch going through it will be slow. Collapsing that into a
boolean would discard the one difference an operator cares about when choosing an
egress.

**Proxy addresses are checked by the egress guard.** The proxy list is operator input
like any other, and it is the one part that names a host rutekit will contact — so it
gets the same check as a provider URL (SEC-4). An entry pointing at a private address
is rejected, not probed.

**Any HTTP answer means the proxy works.** A 403 from the target is a working proxy
and a rejecting endpoint; the probe asks whether the egress carries the request, not
whether the target likes it.

### 4. Import reports per line, and the line numbers are correct

A two-hundred-line paste usually has one defective line, so one bad line must not lose
the other hundred and ninety-nine. `bulkResult` reports every failure against **the
line number in the operator's paste**, not the index in the filtered array.

The difference is real: filtering empty lines first and numbering afterwards would
shift every number past the first empty line — pointing at the wrong line, which is
worse than not pointing at all. This bug was caught by a test, and the fix is to index
over the original `split` result, empty lines included.

### 5. Line parser: from the right, and every scheme is recognized

A paste arrives in whatever form the vendor uses, so both the scheme and the
credentials are optional. Two rules decide whether it is correct:

- **The last `@` and the last `:` are the separators.** Passwords made by a generator
  routinely contain one of them, and splitting on the first occurrence would cut the
  host into the password — producing a proxy that connects to nothing.
- **Every scheme is recognized, not only the three supported.** Matching only the
  supported ones would let `ftp://host:21` slip past the scheme branch and then read
  `ftp://host` as the hostname: a pool entry pointing at nothingness, accepted without
  a word. Catching every scheme is what makes "unknown scheme" a rejection. Also a bug
  caught by a test.

A bracketed IPv6 literal is handled separately, because the address carries colons of
its own.

### 6. Credentials are encoded when forming the URL

`proxyUrl` _percent-encodes_ its credentials. A password containing `@` or `/` would
change where the URL points — the same class of bug as the right-to-left split above,
from the other direction.

### 7. An SMS key that is switched off stays off

A check reads a balance; it does not overturn someone's decision to switch the key
off. The same rule as a manually disabled pool account (ADR-0020), and for the same
reason: an operator's decision is not something an automatic read may reverse.

**Failure is a status, not a throw.** A key that 401s, a service that 500s, and a
network that does not answer mean the same thing to the operator — this key will not
rent a number — so all of them become `error` and the details go to the log. Throwing
would fail the whole pool check because of one bad key, which is exactly the case the
pool exists to survive.

**A negative balance is clamped to zero.** 5sim reports debt as a negative number, and
`nonnegative` in the contract is the honest reading for "nothing left".

**An unrecognized body is `error`, not `active`.** A service that answers but not in a
readable shape does not prove the key works.

## Consequences

**Positive**

- No credential can escape through any read model; both tables use the same box and
  masking conventions as provider accounts.
- Trustworthy health: every verdict is a measurement, with its own measurement time.
- A large paste survives one defective line, and points at the correct line.
- No new dependencies — Bun's `fetch` already brings native proxy support, so there is
  no agent to install and no extra surface.
- Both pools get the same egress guard as any other outbound call.

**Negative / risks**

- **Checking is sequential.** A pool of two hundred is probed one at a time, so a full
  check can take a while. Accepted: probing two hundred at once means opening two
  hundred sockets from one machine, which looks like a flood — and the operator is
  watching the table fill, not measuring throughput.
- **The probe relies on one public endpoint.** `RUTEKIT_PROXY_PROBE_URL` can be
  pointed elsewhere, but the default is a single host; if that host is unreachable
  from the instance's network, every proxy will look dead.
- **The balance is whatever the service says.** There is no reconciliation with actual
  usage; a key whose balance is misreported will be misreported here too.
- **`keyHint` can leak the first and last four characters.** For a long key that is a
  hint, not a disclosure — and the convention matches the existing API key panel.
- **The egress guard rejects documentation ranges.** Addresses like `203.0.113.x`
  (TEST-NET-3) are rejected as non-public, so an instance that genuinely uses such an
  address needs an allowlist. This is correct behavior, but surprising when first
  encountered in a test.

## Rejected alternatives

| Alternative                                      | Reason for rejection                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Deriving health from the address                 | This page exists to be a basis for decisions; guessed health is worse than none       |
| Two verdicts (up/down)                           | Loses the one difference an operator cares about when choosing an egress              |
| Using `socks-proxy-agent` + undici               | Two dependencies for something Bun's `fetch` already brings natively                  |
| Probing the whole pool in parallel               | Two hundred sockets from one machine is a flood, and the results are no sooner useful |
| Filtering empty lines before numbering           | Shifts every line number past the first empty line                                    |
| Matching only supported schemes                  | `ftp://host:21` slips through and its host becomes `ftp://host`                       |
| Splitting credentials on the first `@`           | A password containing `@` cuts the host into the password                             |
| Storing a derived `keyHint`                      | Every list read would have to decrypt, for a value that never changes                 |
| Leaving `lastCheckedAt` when the address changes | Displays a check that never happened                                                  |
| Leaving the old health when the address changes  | That verdict is about a different address                                             |
| Throwing when a check fails                      | One bad key fails the whole pool check                                                |
| A check that wakes a disabled key                | Reverses the operator's decision, just like the bug ADR-0020 rejected for accounts    |
| Reading the 5sim body through a full schema      | Breaks on the next field the service adds                                             |
| Reporting an unknown body as `active`            | Answering does not mean the key works                                                 |
