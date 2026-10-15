/**
 * @rutekit/provider-registry — the declarative provider catalogue.
 *
 * One file per provider under `providers/`, one generated index, and the schema
 * that says what a provider definition may contain. The catalogue is a curated
 * one (ADR-0006): every provider here is meant to have a verified model listing,
 * a documented model mapping, classified errors, and either a working quota
 * check or a written reason it does not apply — the manifest's own fields are
 * where each of those is answered, so "not done yet" cannot hide as a blank.
 *
 * The schema checks one field at a time; `invariants.ts` checks the fields
 * against each other, and `registry.ts` runs both over the whole catalogue and
 * refuses to build if anything disagrees. Callers hold the registry, not the
 * manifest list.
 *
 * `discovery.ts` is the other half: it takes a manifest and asks the provider two
 * questions — which models do you serve, and are you reachable — turning either
 * answer, including a refusal, into the read model the API serves. `classify.ts`
 * is what reads a provider's error rules, and `transport.ts` holds the URL and
 * credential assembly both of them need.
 *
 * Server-only, and the web boundary test enforces it. A manifest carries
 * endpoints, auth flows and the shapes of upstream responses; the console is
 * meant to learn about a provider from the API and `@contracts`, not from the
 * definition itself. That is also what lets the registry grow fetch calls and
 * OAuth machinery without anyone having to notice the day it stopped being safe
 * to bundle.
 *
 * Nothing here performs I/O. Discovery takes an HTTP client as an argument rather
 * than reaching for a global `fetch`, and a manifest is inert data — which is
 * what lets the whole package be exercised without a network or a host runtime
 * standing behind it.
 */

export * from './classify.ts';
export * from './discovery.ts';
export * from './invariants.ts';
export * from './listing.ts';
export * from './manifest.ts';
export * from './registry.ts';
export * from './transport.ts';
