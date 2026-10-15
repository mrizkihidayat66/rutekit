import type {
  Provider,
  ProviderDetail,
  ProviderInput,
  ProviderModel,
  ProviderModelInput,
  ProviderTestResult,
  ProviderUpdate,
} from '@contracts';
import { listModels, testConnection } from '@registry';
import type { Fetcher, ProviderManifest } from '@registry';
import type { Logger } from 'pino';

import { AppError } from '@server/errors.ts';
import type { ProviderAccountsRepository } from '@server/persistence/provider-accounts.ts';
import type { ProviderRepository } from '@server/persistence/providers.ts';
import { requireSecrets } from '@server/providers/oauth/resolve.ts';
import type { SecretBox } from '@server/security/secret-box.ts';

import type { ProviderCatalog } from './provider-catalog.ts';

/**
 * The Providers section's write side (C13a, FR-2.4–2.6).
 *
 * Three things happen here that the read model has no business doing: a provider
 * is created, a provider is removed, and an endpoint is probed. All three are
 * bounded by one rule — **the catalogue is not the operator's to change**.
 *
 * A curated provider is a manifest: rutekit ships it, and `PATCH` or `DELETE` on
 * one is refused rather than silently ignored, because a console that appeared to
 * accept the edit and then reverted it on the next boot would be lying about what
 * it stored. An operator's own provider is a row, and the row is theirs.
 *
 * **Creating a provider with a key creates two things.** The row describes the
 * endpoint; the key is an *account*, stored through the encrypted path every other
 * credential uses. That is the split the pool already understands — one endpoint,
 * many credentials — and it means a BYOK provider's key is revocable, rotatable
 * and quota-tracked like any other account's.
 *
 * **A model's source is its owner, and the boundary is enforced here.** `custom`
 * entries are the operator's, so they may be edited and removed. `synced` entries
 * are what the endpoint said last time it was asked: editing one would be storing
 * a value the next fetch overwrites. `template` entries are the manifest's, and
 * they are not rows at all — so the refusal for those is a refusal to invent one.
 */

/** The slug an id is derived from: letters, digits, and single dashes. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64);
}

export interface ProviderService {
  create(input: ProviderInput): Provider;
  update(id: string, patch: ProviderUpdate): Provider;
  remove(id: string): void;
  /** Probe the endpoint and report what happened. */
  test(id: string): Promise<ProviderTestResult>;
  /** Ask the endpoint what models it has, and store what it says. */
  fetchModels(id: string): Promise<readonly ProviderModel[]>;
  createModel(providerId: string, input: ProviderModelInput): ProviderModel;
  updateModel(providerId: string, modelId: string, input: ProviderModelInput): ProviderModel;
  removeModel(providerId: string, modelId: string): void;
}

export interface ProviderServiceDeps {
  readonly catalog: ProviderCatalog;
  readonly providers: ProviderRepository;
  readonly accounts: ProviderAccountsRepository;
  /** Null when no encryption key is configured, which makes a keyed create refuse. */
  readonly secrets: SecretBox | null;
  /**
   * The registry's own fetcher, not the data plane's.
   *
   * Probing and model discovery are the registry's readers, so this is the shape
   * they take — and it is the *same* egress-checked fetcher either way, which is
   * what keeps the guard from having to be remembered twice.
   */
  readonly fetch: Fetcher;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export function createProviderService(deps: ProviderServiceDeps): ProviderService {
  const now = deps.now ?? ((): Date => new Date());
  const newId = deps.newId ?? ((): string => crypto.randomUUID());

  /** The manifest behind an id, from either source, or a 404. */
  function requireManifest(id: string): ProviderManifest {
    const manifest = deps.catalog.manifestOf(id);
    if (manifest === null) throw AppError.notFound(`No provider with id ${id}.`);
    return manifest;
  }

  /** Refuse a change to a curated provider, naming what to do instead. */
  function requireEditable(id: string): void {
    requireManifest(id);
    if (deps.catalog.isCurated(id)) {
      throw AppError.invalidRequest(
        `${id} comes from rutekit's own catalogue and cannot be changed. Create a BYOK provider to describe your own endpoint.`,
      );
    }
  }

  /**
   * A credential for a probe, or null.
   *
   * The first account that is not switched off, because a probe is asking "does
   * this work" and an account an operator disabled is not the one to ask with. A
   * credential that cannot be decrypted is treated as absent rather than fatal:
   * the probe then reports what the endpoint says without one, which is the
   * truthful answer for a key this instance cannot open.
   */
  function credentialFor(providerId: string): string | null {
    const account = deps.accounts
      .listByProvider(providerId)
      .find((row) => row.state !== 'disabled' && row.state !== 'banned');
    if (account === undefined || deps.secrets === null) return null;
    try {
      return deps.secrets.decrypt(account.credentialEnvelope);
    } catch (error) {
      deps.logger.warn({ err: error, providerId, accountId: account.id }, 'credential did not open');
      return null;
    }
  }

  return {
    create(input: ProviderInput): Provider {
      const id = slugify(input.name);
      if (id === '') {
        throw AppError.invalidRequest('A provider name has to contain a letter or a digit.');
      }
      // A collision with a curated id would produce a row the live registry
      // refuses to show, which is a provider that exists and is invisible.
      if (deps.catalog.manifestOf(id) !== null) {
        throw AppError.invalidRequest(`A provider with the id "${id}" already exists.`);
      }

      const at = now().toISOString();
      deps.providers.createProvider({
        id,
        name: input.name,
        description: input.description,
        category: input.category,
        wireFamily: input.wireFamily,
        baseUrl: input.baseUrl,
        docsUrl: input.docsUrl,
        icon: input.icon,
        freeTier: false,
        createdAt: at,
        updatedAt: at,
      });

      if (input.apiKey !== null) {
        // The key is an account, not a column: that is the path every other
        // credential takes, and it is what makes this one revocable and
        // quota-tracked like the rest.
        const secrets = requireSecrets(deps.secrets);
        deps.accounts.create({
          id: newId(),
          providerId: id,
          label: `${input.name} key`,
          credentialEnvelope: secrets.encrypt(input.apiKey),
          authMode: 'api-key',
          emailMasked: null,
          note: null,
          maxInFlight: 1,
          createdAt: at,
          updatedAt: at,
        });
      }

      deps.logger.info({ providerId: id, withKey: input.apiKey !== null }, 'BYOK provider created');
      return detailOrThrow(id);
    },

    update(id: string, patch: ProviderUpdate): Provider {
      requireEditable(id);
      deps.providers.updateProvider(
        id,
        {
          name: patch.name,
          description: patch.description,
          category: patch.category,
          wireFamily: patch.wireFamily,
          baseUrl: patch.baseUrl,
          docsUrl: patch.docsUrl,
          icon: patch.icon,
        },
        now().toISOString(),
      );
      return detailOrThrow(id);
    },

    remove(id: string): void {
      requireEditable(id);
      // Every account that pointed at it is disabled first, and that is not
      // tidiness: the pool reads accounts, not providers, so a credential whose
      // provider is gone would stay selectable and every turn sent to it would
      // fail on an endpoint rutekit no longer knows how to address.
      const at = now().toISOString();
      for (const account of deps.accounts.listByProvider(id)) {
        deps.accounts.setState(account.id, 'disabled', 'its provider was removed', null, at);
      }
      deps.providers.deleteProvider(id);
      deps.logger.info({ providerId: id }, 'BYOK provider removed');
    },

    async test(id: string): Promise<ProviderTestResult> {
      const manifest = requireManifest(id);
      return testConnection(manifest, {
        fetch: deps.fetch,
        credential: credentialFor(id),
        now: () => now().getTime(),
      });
    },

    async fetchModels(id: string): Promise<readonly ProviderModel[]> {
      const manifest = requireManifest(id);

      // `listModels` is the registry's own reader, so a fetch here answers
      // exactly what a warmup check-in answers — one implementation of "what
      // does this endpoint call its models".
      const discovery = await listModels(manifest, {
        fetch: deps.fetch,
        credential: credentialFor(id),
      });

      if (discovery.problem !== null) {
        throw AppError.upstreamError(discovery.problem, { provider: id });
      }
      if (discovery.source === 'template') {
        // A curated provider with a static list has nothing to fetch: the
        // catalogue already holds every model it has, and writing those back as
        // `synced` would make the console claim a discovery that never happened.
        return deps.catalog.models(id);
      }

      const at = now().toISOString();
      deps.providers.replaceSynced(
        id,
        discovery.models.map((model) => ({
          providerId: id,
          modelId: model.id,
          source: 'synced' as const,
          displayName: model.displayName,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          capabilities: model.capabilities,
          inputPricePerMTok: model.inputPricePerMTok,
          outputPricePerMTok: model.outputPricePerMTok,
          deprecated: model.deprecated,
          createdAt: at,
          updatedAt: at,
        })),
      );

      deps.logger.info({ providerId: id, models: discovery.models.length }, 'provider models fetched');
      return deps.catalog.models(id);
    },

    createModel(providerId: string, input: ProviderModelInput): ProviderModel {
      requireManifest(providerId);
      if (deps.catalog.modelOf(providerId, input.id) !== null) {
        throw AppError.invalidRequest(
          `This provider already lists a model with the id "${input.id}".`,
        );
      }

      const at = now().toISOString();
      deps.providers.putModel({
        providerId,
        modelId: input.id,
        source: 'custom',
        displayName: input.displayName,
        contextWindow: input.contextWindow,
        maxOutputTokens: input.maxOutputTokens,
        capabilities: input.capabilities,
        inputPricePerMTok: input.inputPricePerMTok,
        outputPricePerMTok: input.outputPricePerMTok,
        deprecated: false,
        createdAt: at,
        updatedAt: at,
      });
      return modelOrThrow(providerId, input.id);
    },

    updateModel(providerId: string, modelId: string, input: ProviderModelInput): ProviderModel {
      const existing = deps.catalog.modelOf(providerId, modelId);
      if (existing === null) throw AppError.notFound(`No model with id ${modelId} on ${providerId}.`);
      // The provider told us about this one, so it is the provider's claim and not
      // ours to rewrite — the next fetch would undo the edit.
      if (existing.source !== 'custom') {
        throw AppError.invalidRequest(
          `The model "${modelId}" was not added by hand, so it cannot be edited.`,
        );
      }
      if (input.id !== modelId && deps.catalog.modelOf(providerId, input.id) !== null) {
        throw AppError.invalidRequest(
          `This provider already lists a model with the id "${input.id}".`,
        );
      }

      const at = now().toISOString();
      if (input.id !== modelId) {
        // A rename is a new id, so the old row has to go. Both writes happen here
        // rather than in the repository because the pair is the caller's intent —
        // "this model is now called that" — and half of it would be a model
        // listed twice.
        deps.providers.deleteModel(providerId, modelId);
      }
      deps.providers.putModel({
        providerId,
        modelId: input.id,
        source: 'custom',
        displayName: input.displayName,
        contextWindow: input.contextWindow,
        maxOutputTokens: input.maxOutputTokens,
        capabilities: input.capabilities,
        inputPricePerMTok: input.inputPricePerMTok,
        outputPricePerMTok: input.outputPricePerMTok,
        deprecated: false,
        createdAt: at,
        updatedAt: at,
      });
      return modelOrThrow(providerId, input.id);
    },

    removeModel(providerId: string, modelId: string): void {
      const existing = deps.catalog.modelOf(providerId, modelId);
      if (existing === null) throw AppError.notFound(`No model with id ${modelId} on ${providerId}.`);
      if (existing.source !== 'custom') {
        throw AppError.invalidRequest(
          `The model "${modelId}" was not added by hand, so it cannot be removed.`,
        );
      }
      deps.providers.deleteModel(providerId, modelId);
    },
  };

  function detailOrThrow(id: string): Provider {
    const detail: ProviderDetail = deps.catalog.detail(id);
    return detail.provider;
  }

  function modelOrThrow(providerId: string, modelId: string): ProviderModel {
    const model = deps.catalog.modelOf(providerId, modelId);
    if (model === null) throw AppError.internal(new Error(`model ${modelId} vanished after a write`));
    return model;
  }
}
