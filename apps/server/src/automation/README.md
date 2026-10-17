# `automation`

The bridge from the gateway to browser-driven provider sign-ups: the two credential
pools it draws on, and the supervisor that runs one Node worker per job (C7, ADR-0009).

## What it owns

Everything about a bulk import that does _not_ need a browser — the proxy pool, the SMS
number pool, the batch parser, the machine-capacity cap — plus the job manager that
owns a job's lifecycle, its deadline, its manual hand-off and the recovery of a
produced credential into the account pool. The browser itself lives in
`tools/automation-worker`, a separate process that speaks JSON-lines over stdio.

## The files that matter

- **`jobs/manager.ts`** — the supervisor. Owns the ledger, the worker's lifecycle, the
  manual deadline and the readiness window. Steps live in memory and are _not_
  persisted.
- **`launcher.ts`** — `WorkerLauncher`/`WorkerHandle`; the real one spawns Node with
  the worker entrypoint. Both ends validate every frame against the contract.
- **`capacity.ts`** — `effectiveConcurrency(requested) = min(requested, machineLimit)`,
  the smaller of cores and free memory.
- **`payload.ts`** — parses the pasted batch (`bulk-login`/`bulk-token`/`bulk-regist`)
  and masks labels. **`proxy-line.ts`** parses one proxy line; **`proxies.ts`** and
  **`sms-providers.ts`** are the two pool services; **`proxy-probe.ts`** and
  **`sms-check.ts`** are their real, measured health checks.

## Invariants and traps

- **Pause kills.** A browser mid-sign-in cannot be frozen, so `pause` stops the worker
  and returns in-flight items to the queue. The cost is repeated sign-ins; the benefit
  is that a paused job is genuinely paused.
- **The host holds two clocks and no more**: the manual deadline (only the host has a
  clock the console can read) and the readiness window (a worker that never announces
  itself is a failure, not a start). A stall watchdog exists but **stands down while
  `needsManual`** — a worker waiting on a captcha is silent by design and must not be
  killed.
- **The proxy line splits on the LAST `@` and the LAST `:`**, because a password may
  contain either. The batch parser splits on the **first** `:`/`|` for the opposite
  reason — the email may not contain them. These two rules are deliberately opposite.
- **Capacity is a cap, never a floor.** An operator asking for one gets one; the cap
  is reported on the job so a slow batch says why.
- **Credentials are write-only and health is only ever measured.** Proxy/SMS read
  models carry `hasAuth`/`keyHint` and never the secret; a health verdict comes from a
  real probe, never inferred from the address.
- **A disabled SMS key stays disabled through a check** — an automatic reading never
  reverses an operator's decision (same rule as ADR-0020).
- Both probe paths go through the egress guard, so a pool entry naming a private
  address is refused rather than probed.
- **A bulk import can cost the accounts, and some providers notice.** Driving one
  provider's sign-in many times from one address in one run is the pattern a provider
  flags as automated, and it is the operator's accounts that pay for it. This was
  measured rather than reasoned about: a ten-account `kiro` batch through a headless
  browser on one host produced accounts that AWS then locked — `403
  TEMPORARILY_SUSPENDED`, *"we detected unusual user activity"* — so the import
  succeeded and the accounts could not be used. Where a provider offers a sign-in that
  does not look like automation (a device flow, or an account the operator made
  themselves), that is the one to prefer for anything beyond a couple of items, and the
  console's job history is worth reading before a batch is repeated.
- **An imported account arrives `pending`, and takes its first turn only after a probe
  proves it.** That is deliberate — nothing has used the credential yet — but it means a
  batch that finishes is not yet a batch that works: the accounts enter the rotation when
  the warmup check-in first reaches them, which is within one `RUTEKIT_WARMUP_INTERVAL_MS`
  (fifteen minutes by default). An operator who wants them now can run a check-in from the
  Accounts page, or press Enable, which is the same move made by hand. Before `probePath`
  existed this never happened for a curated provider, and the accounts were unusable
  indefinitely rather than briefly — see `pool/README.md`.
