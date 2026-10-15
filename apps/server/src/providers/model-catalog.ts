import type { WireFamily } from '@contracts';
import type { ManifestModel, ProviderManifest, ProviderRegistry } from '@registry';

/**
 * Turning a model id a client asked for into the provider that serves it (C4.6).
 *
 * The registry is a catalogue of providers; a `/v1` client sends a model id and
 * nothing else, so something has to answer "who serves this, and how do I call
 * them". That is all this is. It is deliberately not routing: aliases, combos and
 * model mapping resolve *to* an id, and then hand that id to this — so the
 * dispatcher never learns about them, and this file never learns that they exist.
 *
 * Resolution is first-match over the registry's own order. Two providers may
 * legitimately curate the same id — a first-party API and an aggregator that
 * proxies it — and the order the catalogue lists them is the operator's stated
 * preference, so it is honoured rather than second-guessed.
 *
 * The `/v1/models` listing is *not* here, because it is not this question. What a
 * client can ask for is the catalogue plus the operator's own aliases and combos,
 * which is a question about the plan; see `plan/listing.ts`.
 */

export interface ResolvedModel {
  readonly providerId: string;
  readonly manifest: ProviderManifest;
  readonly model: ManifestModel;
  /** The id the provider expects, which is not always the id the client sent. */
  readonly upstreamId: string;
  /** The dialect to speak, which a single model can override for its provider. */
  readonly family: WireFamily;
}

export interface ModelCatalog {
  /**
   * The provider that serves `modelId`, or null when nothing curates it.
   *
   * `providerId` narrows the search to one provider, which is what an alias's own
   * pin or a combo entry's pin needs: two providers may curate the same id, and a
   * pin is the operator saying which of them they meant. A pin naming a provider
   * that does not curate the id resolves to nothing rather than falling back to
   * the other one — a silent fallback would make the pin a suggestion.
   */
  resolve(modelId: string, providerId?: string | null): ResolvedModel | null;
}

export interface ModelCatalogDeps {
  readonly registry: ProviderRegistry;
}

export function createModelCatalog(deps: ModelCatalogDeps): ModelCatalog {
  return {
    resolve(modelId: string, providerId: string | null = null): ResolvedModel | null {
      for (const manifest of deps.registry.all()) {
        if (providerId !== null && manifest.id !== providerId) continue;
        for (const model of manifest.models) {
          if (model.id !== modelId) continue;
          return {
            providerId: manifest.id,
            manifest,
            model,
            upstreamId: model.upstreamId ?? model.id,
            family: model.wireFamily ?? manifest.endpoint.wireFamily,
          };
        }
      }
      return null;
    },
  };
}
