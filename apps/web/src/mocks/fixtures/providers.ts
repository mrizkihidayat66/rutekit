import type { Provider, ProviderModel, ProviderStatus } from '@contracts';

import { daysAgo, hoursAgo } from '../clock.ts';
import type { Rng } from '../random.ts';
import { PROVIDER_CATALOG, type ModelSeed, type ProviderSeed } from './provider-catalog.ts';

/**
 * The catalog holds *seeds*; this module turns them into the read models the
 * API returns. Splitting the two is deliberate: the seed list is a curated
 * editorial artefact that should not carry mock state (status, counts,
 * timestamps), and the read model is a projection that must.
 */

const STATUS_WEIGHTS: Readonly<
  Record<'good' | 'mixed' | 'poor', readonly (readonly [ProviderStatus, number])[]>
> = {
  good: [
    ['ready', 92],
    ['needs_auth', 5],
    ['error', 2],
    ['disabled', 1],
  ],
  mixed: [
    ['ready', 70],
    ['needs_auth', 16],
    ['error', 9],
    ['disabled', 5],
  ],
  poor: [
    ['ready', 45],
    ['needs_auth', 22],
    ['error', 20],
    ['disabled', 13],
  ],
};

export interface AccountCounts {
  total: number;
  active: number;
}

function statusFor(seed: ProviderSeed, rng: Rng): ProviderStatus {
  // A provider with no credential surface cannot be "needs_auth"; it is either
  // reachable (local, free) or switched off by an operator.
  const bias = seed.healthBias ?? 'good';
  const status = rng.weighted(STATUS_WEIGHTS[bias]);
  if (
    status === 'needs_auth' &&
    !seed.capabilities.oauth &&
    seed.category !== 'api-key' &&
    seed.category !== 'aggregator' &&
    seed.category !== 'byok' &&
    seed.category !== 'free'
  ) {
    return 'ready';
  }
  return status;
}

/**
 * A seed's `K` count as a token count, or `null` when there is none.
 *
 * The seed list uses `contextK: 0` for the models that genuinely have no context
 * window — diffusion, video, speech, upscalers — and `0` is not a size, it is the
 * absence of one. The contract says `positive | null`, so mapping it to `null`
 * here is both what the schema requires and what is true: an image model does not
 * read a 0-token prompt.
 */
function tokensFromK(k: number | undefined, fallbackK: number): number | null {
  const value = k ?? fallbackK;
  return value > 0 ? value * 1_000 : null;
}

function toModel(seed: ProviderSeed, model: ModelSeed): ProviderModel {
  const embedding = model.embedding ?? false;
  return {
    id: model.id,
    providerId: seed.id,
    displayName: model.displayName ?? model.id,
    // The curated catalog's own list: read-only, because the next catalog
    // revision would replace whatever an operator wrote over it.
    source: 'template',
    contextWindow: embedding ? null : tokensFromK(model.contextK, 128),
    maxOutputTokens: embedding ? null : tokensFromK(model.maxOutputK, 8),
    capabilities: {
      vision: model.vision ?? false,
      tools: embedding ? false : (model.tools ?? false),
      reasoning: model.reasoning ?? false,
      embedding,
    },
    inputPricePerMTok: model.inputPrice ?? null,
    outputPricePerMTok: model.outputPrice ?? null,
    deprecated: model.deprecated ?? false,
  };
}

export interface ProviderBundle {
  providers: Provider[];
  models: ProviderModel[];
}

export function buildProviders(
  rng: Rng,
  counts: ReadonlyMap<string, AccountCounts>,
): ProviderBundle {
  const providers: Provider[] = [];
  const models: ProviderModel[] = [];

  for (const seed of PROVIDER_CATALOG) {
    const status = statusFor(seed, rng);
    const account = counts.get(seed.id) ?? { total: 0, active: 0 };
    providers.push({
      id: seed.id,
      name: seed.name,
      description: seed.description,
      category: seed.category,
      status,
      icon: seed.icon,
      baseUrl: seed.baseUrl,
      wireFamily: seed.wireFamily,
      docsUrl: seed.docsUrl,
      freeTier: seed.freeTier,
      capabilities: seed.capabilities,
      modelCount: seed.models.length,
      accountCount: account.total,
      activeAccountCount: account.active,
      createdAt: daysAgo(rng.int(30, 400)),
      updatedAt: hoursAgo(rng.int(1, 500)),
    });

    for (const model of seed.models) models.push(toModel(seed, model));
  }

  return { providers, models };
}

/** Every (providerId, model) pair, used to seed request logs and pickers. */
export function modelRefs(
  models: readonly ProviderModel[],
): { providerId: string; model: string }[] {
  return models
    .filter((model) => !model.deprecated)
    .map((model) => ({ providerId: model.providerId, model: model.id }));
}

/**
 * The models a freshly added BYOK endpoint "lists" when its models are fetched.
 *
 * A BYOK provider is configured rather than discovered, so the curated catalog
 * has nothing to say about it. Answering the auto-fetch with an empty list would
 * make the feature look broken, so the mock replies with the small, generic set
 * an OpenAI-compatible endpoint tends to advertise.
 */
const SYNTHETIC_TIERS = [
  {
    suffix: 'mini',
    contextK: 32,
    maxOutputK: 4,
    vision: false,
    reasoning: false,
    input: 0.15,
    output: 0.6,
  },
  {
    suffix: 'standard',
    contextK: 128,
    maxOutputK: 8,
    vision: true,
    reasoning: false,
    input: 1.5,
    output: 6,
  },
  {
    suffix: 'pro',
    contextK: 200,
    maxOutputK: 16,
    vision: true,
    reasoning: true,
    input: 6,
    output: 24,
  },
] as const;

export function synthesizeModels(provider: Provider): ProviderModel[] {
  return SYNTHETIC_TIERS.map((tier) => ({
    id: `${provider.id}-${tier.suffix}`,
    providerId: provider.id,
    displayName: `${provider.name} ${tier.suffix}`,
    // What the endpoint answered: read-only for the same reason as `template`,
    // and replaced wholesale by the next fetch.
    source: 'synced',
    contextWindow: tier.contextK * 1_000,
    maxOutputTokens: tier.maxOutputK * 1_000,
    capabilities: { vision: tier.vision, tools: true, reasoning: tier.reasoning, embedding: false },
    inputPricePerMTok: tier.input,
    outputPricePerMTok: tier.output,
    deprecated: false,
  }));
}
