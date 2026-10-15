import type { ProviderManifestInput } from '@registry';

import type { ProviderModelRow, ProviderRepository, ProviderRow } from '@server/persistence/providers.ts';

/**
 * A stored BYOK provider as the registry reads it (C13a, FR-2.4).
 *
 * The registry speaks manifests and nothing else — that is ADR-0018, and it is
 * what keeps routing, the pool and the catalog from each learning a second shape.
 * A BYOK provider is a row, so something has to turn it into a manifest before
 * the registry can hold it, and this is that something.
 *
 * **The conversion is where the row is validated.** A curated manifest is parsed
 * and cross-checked at boot, because a contradiction there is a bug in rutekit.
 * A row is written at runtime by an operator, so the check has to happen at the
 * moment it is written — which is exactly what this function is for: it produces
 * a `ProviderManifestInput` that `createLiveProviderRegistry` parses, and a row
 * that does not survive the parse simply does not appear.
 *
 * **A BYOK provider speaks an API-key wire and says so.** Its `authModes` is one
 * api-key mode, because that is the only way an operator can hand rutekit a
 * credential for an endpoint rutekit has no sign-in for. The header it uses is
 * the one the wire family expects — `Authorization: Bearer` for an OpenAI-compatible
 * endpoint, `x-api-key` for an Anthropic-compatible one — which is a fact about
 * the dialect rather than something to ask an operator to retype.
 *
 * **Discovery follows the wire family, and that is what makes the fetch route
 * work.** An OpenAI-compatible endpoint lists its models at `/models` in the OpenAI
 * envelope, an Anthropic-compatible one in Anthropic's, a Google-compatible one
 * in Google's — so the strategy is the family's own dialect, and the registry's
 * existing reader is what asks. A `custom` family has no listing dialect rutekit
 * knows, so it is `static`: there is nothing to ask for, and the operator's own
 * entries are the whole list.
 *
 * The list is still *stored* rather than read live. A discovery strategy says how
 * to ask, not when; routing must not depend on a network call, and the operator
 * chooses when to re-fetch.
 */

/** The header an api-key credential goes in, per wire family. */
const AUTH_HEADER: Readonly<Record<string, string>> = {
  openai: 'Authorization',
  anthropic: 'x-api-key',
  google: 'x-goog-api-key',
  custom: 'Authorization',
};

/** The scheme, where the family needs one. Anthropic's header carries the raw key. */
const AUTH_SCHEME: Readonly<Record<string, string>> = {
  openai: 'Bearer',
  anthropic: '',
  google: '',
  custom: 'Bearer',
};

/**
 * The listing dialect for a wire family, or `static` when there is none.
 *
 * The three families rutekit can read a listing from answer in their own
 * envelope; `custom` is a wire rutekit does not know, so there is nothing to ask
 * for and the operator's entries are the whole list.
 */
function listingStrategy(wireFamily: string): 'openai' | 'anthropic' | 'google' | 'static' {
  if (wireFamily === 'openai') return 'openai';
  if (wireFamily === 'anthropic') return 'anthropic';
  if (wireFamily === 'google') return 'google';
  return 'static';
}

export function storedProviderManifests(
  providers: ProviderRepository,
): readonly ProviderManifestInput[] {
  const models = providers.listModels();
  const byProvider = new Map<string, ProviderModelRow[]>();
  for (const model of models) {
    const bucket = byProvider.get(model.providerId);
    if (bucket === undefined) byProvider.set(model.providerId, [model]);
    else bucket.push(model);
  }

  return providers.listProviders().flatMap((row) => {
    const manifest = toManifest(row, byProvider.get(row.id) ?? []);
    // A row with no base URL cannot be addressed, so it is not a provider the
    // router could use — and a manifest that would fail its own invariants is
    // dropped here rather than taking the merged registry's read down.
    return manifest === null ? [] : [manifest];
  });
}

/** One row and its models, or null when the row could not describe an endpoint. */
export function toManifest(
  row: ProviderRow,
  models: readonly ProviderModelRow[],
): ProviderManifestInput | null {
  const baseUrl = row.baseUrl;
  if (baseUrl === null || baseUrl.trim() === '') return null;

  const header = AUTH_HEADER[row.wireFamily] ?? 'Authorization';
  const scheme = AUTH_SCHEME[row.wireFamily] ?? 'Bearer';

  return {
    id: row.id,
    name: row.name,
    description: row.description === '' ? `A ${row.wireFamily}-compatible endpoint.` : row.description,
    category: row.category as ProviderManifestInput['category'],
    icon: row.icon,
    docsUrl: row.docsUrl,
    freeTier: row.freeTier,
    endpoint: {
      baseUrl,
      wireFamily: row.wireFamily as ProviderManifestInput['endpoint']['wireFamily'],
      chatPath: null,
      headers: {},
    },
    authModes: [
      scheme === '' ? { mode: 'api-key', header } : { mode: 'api-key', header, scheme },
    ],
    capabilities: {
      // A BYOK endpoint is one an operator pointed rutekit at, so rutekit knows
      // nothing about its allowance, its sign-in or whether it can be automated:
      // every one of those is false because it is unclaimed, not because it is
      // impossible. `streaming`, `vision` and `tools` are true because the
      // families that speak these wires do, and a model the operator adds says
      // for itself what it can do.
      quota: false,
      oauth: false,
      automation: false,
      streaming: true,
      vision: true,
      tools: true,
    },
    discovery: { strategy: listingStrategy(row.wireFamily), requiresCredential: true },
    models: models.map((model) => ({
      id: model.modelId,
      displayName: model.displayName,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: model.capabilities,
      inputPricePerMTok: model.inputPricePerMTok,
      outputPricePerMTok: model.outputPricePerMTok,
      deprecated: model.deprecated,
      upstreamId: null,
      wireFamily: null,
    })),
    quota: {
      kind: 'none',
      reason: 'A hand-configured endpoint reports no allowance rutekit knows how to read.',
    },
    errors: [
      { class: 'rate_limit', statuses: [429] },
      { class: 'auth', statuses: [401, 403] },
      { class: 'transient', statuses: [500, 502, 503, 504] },
    ],
  };
}
