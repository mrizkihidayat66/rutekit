# `provider-registry`

The declarative provider catalogue: one manifest per provider, plus the discovery,
classification and transport code that reads one (ADR-0006, ADR-0018).

## What it owns

The only place rutekit describes a provider. Every other surface — the catalogue page, the
model list, the connection probe, the quota sweep, the router's choice of wire — reads a
manifest and derives its own view, which keeps a provider from being described twice.

## The files that matter

- **`src/providers/`** — one file per provider, one object literal each. `index.ts` inside it
  is generated; never edit it by hand.
- **`scripts/generate-index.ts`** and **`scripts/render-index.ts`** — `bun run generate`
  rebuilds the index from the directory listing, in a module the staleness test calls.
- **`src/manifest.ts`** and **`src/manifest/`** — `providerManifestSchema`, grouped by concern
  with one file per group, and the split between `ProviderManifestInput` (what a provider file
  writes) and `ProviderManifest` (what the registry hands out, every default applied).
- **`src/invariants.ts`** — `checkManifest`: the checks a schema cannot state because they
  span fields, collected rather than thrown so one manifest reports all of its problems.
- **`src/registry.ts`** — `createProviderRegistry` (parse, check, or throw) and
  `createLiveProviderRegistry` (that catalogue plus operator-written rows).
- **`src/discovery.ts`**, **`src/listing.ts`**, **`src/classify.ts`** — `listModels`,
  `testConnection`, the per-dialect `parseListing` and `classifyFailure`.
- **`src/transport.ts`** — `endpointUrl`, `resolveTemplate`, `applyAuth`, and the `Fetcher`,
  `HttpRequest` and `HttpResponse` types.

## Invariants and traps

- **A provider is data, not code.** A manifest is an object literal — no functions, no closures
  — so the catalogue can be parsed, cross-checked and asserted with no network behind it. The cost
  is the reverse: whatever a manifest cannot express lives in the code that reads it.
- **Adding a provider is one file plus a regeneration.** Drop `foo.ts` into `src/providers/`,
  export a symbol matching the file name, run `bun run generate`. A stale or hand-edited index
  fails `providers-index.test.ts` rather than surfacing at boot.
- **The schema checks one field; `invariants.ts` checks fields against each other.** The schema
  cannot state that exactly one of the two URL forms must be set, nor that an `oauth` capability
  agrees with the auth modes beside it. Both are checked at construction, so a contradiction is a
  loud boot failure rather than a 500 on whichever request arrives first, and "not done yet"
  cannot hide as a blank: a provider with no quota checker writes `kind: 'none'` and a reason.
- **A live row cannot shadow a curated one.** `createLiveProviderRegistry` merges on every read,
  curated first, skipping any id the base already holds, so an operator cannot replace a catalogue
  entry by naming a row after it. A row that will not parse is skipped rather than fatal: it is
  checked when written, and the read path survives what the write path refused. It is a wrapper
  and not a rebuild because callers hold one registry from boot and read it per request.
- **A URL comes from one of two forms, never both.** `baseUrl` is used as written;
  `baseUrlTemplate` is resolved against the account's values, collecting every unresolved
  placeholder at once rather than one edit at a time. A non-empty `missing` means unreachable.
  `applyAuth` applies the first auth mode only, since a probe holds one credential, not a set.
- **An unreadable listing is not an error.** `parseListing` answers null and the caller degrades
  to an empty list plus a sentence, so a provider that changes its envelope does not take the
  catalogue down. A synced id keeps the capabilities and prices the manifest curated for it.
- **This package is banned in the frontend.** `apps/web/test/boundary.test.ts` forbids
  `@rutekit/provider-registry` and the `@registry` alias: a manifest carries endpoints and auth
  flows, and the console learns about providers through the API and `@contracts` instead.
- **Nothing here performs I/O.** `discovery.ts` takes a `Fetcher` as an argument rather than
  reaching for the global, so the behaviour worth testing is driven by a fake, with no socket.
