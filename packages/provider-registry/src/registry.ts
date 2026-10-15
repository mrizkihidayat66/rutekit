import type { ProviderCategory } from '@contracts';

import { checkManifest, type ManifestIssue } from './invariants.ts';
import {
  providerManifestSchema,
  type ProviderManifest,
  type ProviderManifestInput,
} from './manifest.ts';

/**
 * The catalogue as one object: parse the lot, check the lot, hand out lookups.
 *
 * Built by `createProviderRegistry` rather than exported as a bare array, because
 * a bare array invites every caller that wants an id-to-provider map to build its
 * own — and then to disagree with the next one about what happens when an id is
 * missing. The registry is the single answer: it holds the only map, it decides
 * that a lookup miss is `undefined` rather than an exception, and it refuses to
 * exist at all if the catalogue contradicts itself.
 *
 * The refusal is the point. A half-built registry that throws on the one broken
 * provider would surface the fault as a 500 on whichever request happened to
 * reach it first, which is both late and misleading. Parsing and checking at
 * construction turns every contradiction into one loud failure at boot, before
 * anything has been served.
 */
export interface ProviderRegistry {
  /** How many providers the catalogue holds. */
  readonly size: number;
  /** Every provider, in the order the catalogue declares them. */
  all(): readonly ProviderManifest[];
  /** Every provider id, in catalogue order. */
  ids(): readonly string[];
  has(id: string): boolean;
  /** The provider, or `undefined` — the caller decides whether that is a 404. */
  get(id: string): ProviderManifest | undefined;
  byCategory(category: ProviderCategory): readonly ProviderManifest[];
}

/**
 * Every contradiction found while building the catalogue.
 *
 * Carries the full list rather than the first problem, so a bad edit to several
 * manifests is one report instead of one report per re-run.
 */
export class ProviderRegistryError extends Error {
  readonly issues: readonly ManifestIssue[];

  constructor(issues: readonly ManifestIssue[]) {
    super(formatIssues(issues));
    this.name = 'ProviderRegistryError';
    this.issues = issues;
  }
}

/**
 * Parse the declared manifests and build the catalogue, or throw.
 *
 * Takes `ProviderManifestInput`, not `ProviderManifest`, because a provider file
 * states only what it decides and lets the schema fill the rest — this parse is
 * what makes that a real guarantee rather than a type assertion.
 */
export function createProviderRegistry(inputs: readonly ProviderManifestInput[]): ProviderRegistry {
  const issues: ManifestIssue[] = [];
  const manifests: ProviderManifest[] = [];

  for (const input of inputs) {
    const result = providerManifestSchema.safeParse(input);
    if (!result.success) {
      issues.push(...parseIssues(input, result.error));
      continue;
    }
    manifests.push(result.data);
    issues.push(...checkManifest(result.data));
  }

  const byId = new Map<string, ProviderManifest>();
  for (const manifest of manifests) {
    if (byId.has(manifest.id)) {
      issues.push({
        providerId: manifest.id,
        field: 'id',
        message: 'is declared by more than one provider file',
      });
      continue;
    }
    byId.set(manifest.id, manifest);
  }

  if (issues.length > 0) throw new ProviderRegistryError(issues);

  return build(manifests, byId);
}

function build(
  manifests: readonly ProviderManifest[],
  byId: ReadonlyMap<string, ProviderManifest>,
): ProviderRegistry {
  const buckets = new Map<ProviderCategory, ProviderManifest[]>();
  for (const manifest of manifests) {
    const bucket = buckets.get(manifest.category);
    if (bucket === undefined) buckets.set(manifest.category, [manifest]);
    else bucket.push(manifest);
  }
  const byCategory = new Map<ProviderCategory, readonly ProviderManifest[]>();
  for (const [category, bucket] of buckets) byCategory.set(category, Object.freeze(bucket));

  const all = Object.freeze([...manifests]);
  const ids = Object.freeze(manifests.map((manifest) => manifest.id));

  return {
    size: all.length,
    all: () => all,
    ids: () => ids,
    has: (id) => byId.has(id),
    get: (id) => byId.get(id),
    byCategory: (category) => byCategory.get(category) ?? EMPTY,
  };
}

const EMPTY: readonly ProviderManifest[] = Object.freeze([]);

/**
 * The catalogue plus the providers an operator configured (C13a, FR-2.4).
 *
 * The curated manifests are immutable and validated once, at boot — that is what
 * `createProviderRegistry` refuses to exist without. A BYOK provider is a row an
 * operator writes while the process is running, so it cannot be part of that
 * check, and the two therefore have to be read together at the moment something
 * asks.
 *
 * **Why this is a wrapper and not a rebuild.** `planner`, `catalog` and `pool`
 * are all handed one registry object at boot and call `all()` on it per request.
 * Rebuilding the registry on every change would leave them holding the old one,
 * and a BYOK provider the console can create but the router cannot reach is a row
 * that lies about being usable. Reading through to a live source is what makes
 * the two halves one catalogue.
 *
 * **A stored row that will not parse is skipped, not fatal.** The base manifests
 * are checked at boot because a contradiction there is a bug in rutekit; a row is
 * checked when it is *written*, and a row that somehow no longer parses is one
 * provider missing from a list rather than a server that stops answering. The
 * write path refuses it; the read path survives it.
 *
 * A live provider may not shadow a curated one: the base wins, so an operator
 * cannot replace a catalogue entry by naming a row after it.
 */
export function createLiveProviderRegistry(
  base: ProviderRegistry,
  live: () => readonly ProviderManifestInput[],
): ProviderRegistry {
  function merged(): readonly ProviderManifest[] {
    const curated = base.all();
    const taken = new Set(curated.map((manifest) => manifest.id));
    const extra: ProviderManifest[] = [];

    for (const input of live()) {
      if (taken.has(input.id)) continue;
      const parsed = providerManifestSchema.safeParse(input);
      if (!parsed.success) continue;
      taken.add(parsed.data.id);
      extra.push(parsed.data);
    }

    // The curated catalogue first, so a list reads in the order rutekit declares
    // and an operator's own providers come after it.
    return [...curated, ...extra];
  }

  return {
    get size(): number {
      return merged().length;
    },
    all: merged,
    ids: () => merged().map((manifest) => manifest.id),
    has: (id) => merged().some((manifest) => manifest.id === id),
    get: (id) => merged().find((manifest) => manifest.id === id),
    byCategory: (category) => merged().filter((manifest) => manifest.category === category),
  };
}

/**
 * Turn a Zod failure into the same shape as a cross-field one, so a malformed
 * manifest and a contradictory one are reported together rather than in two
 * different formats.
 */
function parseIssues(input: unknown, error: { issues: readonly ZodIssue[] }): ManifestIssue[] {
  const providerId = readId(input);
  return error.issues.map((issue) => ({
    providerId,
    field: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

interface ZodIssue {
  readonly path: readonly (string | number | symbol)[];
  readonly message: string;
}

/** The id to blame in a message, when the input is too broken to parse one out. */
function readId(input: unknown): string {
  if (typeof input === 'object' && input !== null && 'id' in input) {
    const id: unknown = input.id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return '(unknown)';
}

function formatIssues(issues: readonly ManifestIssue[]): string {
  const lines = issues.map((issue) => {
    const where = issue.field === '' ? issue.providerId : `${issue.providerId}.${issue.field}`;
    return `  - ${where}: ${issue.message}`;
  });
  const count = `${issues.length} problem${issues.length === 1 ? '' : 's'}`;
  return `provider registry: ${count}\n${lines.join('\n')}`;
}
