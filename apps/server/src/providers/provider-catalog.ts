import type {
  ModelCatalogEntry,
  ModelCatalogResponse,
  Provider,
  ProviderCategory,
  ProviderDetail,
  ProviderModel,
  ProviderStatus,
  ProvidersQuery,
  ProvidersResponse,
} from '@contracts';
import { modelCatalogEntrySchema, providerModelSchema, providerSchema } from '@contracts';
import type { ProviderManifest, ProviderRegistry } from '@registry';

import { AppError } from '@server/errors.ts';
import type { ProviderAccountsRepository, ProviderAccountRow } from '@server/persistence/provider-accounts.ts';
import type { ProviderModelRow, ProviderRepository } from '@server/persistence/providers.ts';
import type { Pool } from '@server/pool/pool.ts';

/**
 * The Providers section's read models (C13a, FR-2.1–2.6).
 *
 * Two sources, one shape. A **manifest** is the curated catalogue and owns
 * `template` models; a **row** is a provider an operator configured and owns its
 * `custom` and `synced` models. The console reads one list, and the contract's
 * `modelSourceSchema` is what says which half a given entry came from — which is
 * also what decides whether it may be edited, so the three sources are three
 * owners rather than three flavours.
 *
 * **Status is derived, never stored.** A manifest declares what a provider *is*;
 * whether it is usable is a fact about its accounts, which change while the
 * process runs. So `ready` means "this has a credential that works right now",
 * and it is computed from the account rows on every read. Storing it would mean
 * a column that is wrong the moment a credential expires — and the console's
 * whole job on this page is to tell an operator which providers are usable.
 *
 * **A provider that needs no credential is ready without one.** A local runner
 * and a public endpoint declare `authModes: [{ mode: 'none' }]`, and reporting
 * them as `needs_auth` would put a sign-in prompt on a provider that has nothing
 * to sign into.
 */

/**
 * The catalogue's own birth, as an ISO string.
 *
 * A manifest has no creation time of its own — it is a file, and the file has
 * been there since the build. The Unix epoch is the honest answer for "this was
 * never created by anybody at a moment", and it reads as such in the console
 * rather than pretending to be a timestamp rutekit measured.
 */
const CATALOGUE_EPOCH = new Date(0).toISOString();

/** The statuses a provider can be in, derived from its accounts. */
function statusOf(manifest: ProviderManifest, accounts: readonly ProviderAccountRow[]): ProviderStatus {
  const needsNothing = manifest.authModes.some((mode) => mode.mode === 'none');
  if (needsNothing) return 'ready';
  if (accounts.length === 0) return 'needs_auth';

  if (accounts.some((account) => account.state === 'active')) return 'ready';
  // Every account unusable, and the reasons are worth telling apart: a provider
  // whose accounts were all switched off by an operator is `disabled`, while one
  // whose accounts all failed is `error`.
  if (accounts.every((account) => account.state === 'disabled')) return 'disabled';
  if (accounts.every((account) => account.state === 'error' || account.state === 'banned')) {
    return 'error';
  }
  return 'needs_auth';
}

/** One manifest model as the console reads it. */
function templateModel(manifest: ProviderManifest, modelId: string): ProviderModel | null {
  const model = manifest.models.find((entry) => entry.id === modelId);
  if (model === undefined) return null;
  return providerModelSchema.parse({
    id: model.id,
    providerId: manifest.id,
    displayName: model.displayName === '' ? model.id : model.displayName,
    source: 'template',
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: model.capabilities,
    inputPricePerMTok: model.inputPricePerMTok,
    outputPricePerMTok: model.outputPricePerMTok,
    deprecated: model.deprecated,
  });
}

/** One stored model row as the console reads it. */
function storedModel(row: ProviderModelRow): ProviderModel {
  return providerModelSchema.parse({
    id: row.modelId,
    providerId: row.providerId,
    displayName: row.displayName,
    // The column is written only from the two values the contract allows, so an
    // unreadable one means the row was edited outside rutekit. `synced` is the
    // safe reading: it is the one an operator cannot edit, so a wrong guess
    // refuses a change rather than allowing one that should not happen.
    source: row.source === 'custom' ? 'custom' : 'synced',
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    capabilities: row.capabilities,
    inputPricePerMTok: row.inputPricePerMTok,
    outputPricePerMTok: row.outputPricePerMTok,
    deprecated: row.deprecated,
  });
}

export interface ProviderCatalog {
  list(query: ProvidersQuery): ProvidersResponse;
  detail(id: string): ProviderDetail;
  models(providerId: string): readonly ProviderModel[];
  /** Every model from every provider, joined to the provider that serves it. */
  modelCatalog(query: ModelCatalogQuery): ModelCatalogResponse;
  /** Whether this id belongs to a manifest, which is what decides editability. */
  isCurated(id: string): boolean;
  /** The manifest for an id, from either source, or null. */
  manifestOf(id: string): ProviderManifest | null;
  /** One model, from either source, or null. */
  modelOf(providerId: string, modelId: string): ProviderModel | null;
}

/** The catalog's filters, mirroring `modelsQuerySchema`. */
export interface ModelCatalogQuery {
  readonly q: string;
  readonly sort: string | null;
  readonly direction: 'asc' | 'desc';
  readonly limit: number;
  readonly cursor: string | null;
  readonly providerId: string | null;
  readonly capability: string | null;
  readonly source: string | null;
  readonly minContext: number | null;
}

export interface ProviderCatalogDeps {
  readonly registry: ProviderRegistry;
  readonly providers: ProviderRepository;
  readonly accounts: ProviderAccountsRepository;
  /** In-flight counts, so an account row reads the way the Accounts page shows it. */
  readonly pool: Pool;
}

export function createProviderCatalog(deps: ProviderCatalogDeps): ProviderCatalog {
  /** Every account, grouped once per read rather than re-queried per provider. */
  function accountsByProvider(): ReadonlyMap<string, readonly ProviderAccountRow[]> {
    const grouped = new Map<string, ProviderAccountRow[]>();
    for (const account of deps.accounts.listAll()) {
      const bucket = grouped.get(account.providerId);
      if (bucket === undefined) grouped.set(account.providerId, [account]);
      else bucket.push(account);
    }
    return grouped;
  }

  /** One provider from either source, as the console reads it. */
  function providerOf(
    manifest: ProviderManifest,
    accounts: readonly ProviderAccountRow[],
    modelCount: number,
  ): Provider {
    return providerSchema.parse({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      category: manifest.category,
      status: statusOf(manifest, accounts),
      icon: manifest.icon,
      baseUrl: manifest.endpoint.baseUrl,
      wireFamily: manifest.endpoint.wireFamily,
      docsUrl: manifest.docsUrl,
      freeTier: manifest.freeTier,
      capabilities: manifest.capabilities,
      modelCount,
      accountCount: accounts.length,
      activeAccountCount: accounts.filter((account) => account.state === 'active').length,
      createdAt: CATALOGUE_EPOCH,
      updatedAt: CATALOGUE_EPOCH,
    });
  }

  function allProviders(): readonly Provider[] {
    const grouped = accountsByProvider();
    const stored = new Map(deps.providers.listProviders().map((row) => [row.id, row]));
    const storedModels = deps.providers.listModels();

    return deps.registry.all().map((manifest) => {
      const accounts = grouped.get(manifest.id) ?? [];
      // A curated provider's models are its manifest's plus whatever the operator
      // added or fetched on top; a BYOK provider has only the stored ones.
      const extra = storedModels.filter((row) => row.providerId === manifest.id).length;
      const row = stored.get(manifest.id);
      const provider = providerOf(manifest, accounts, manifest.models.length + extra);
      // A row cannot shadow a curated provider — the live registry refuses the
      // id — so a curated provider keeps the manifest's own timestamps.
      return row === undefined ? provider : { ...provider, updatedAt: row.updatedAt };
    });
  }

  function modelsOf(providerId: string): readonly ProviderModel[] {
    // A BYOK provider's manifest is *built from* its stored rows (C13a), so
    // reading its models back as `template` would relabel the operator's own
    // entries as the catalogue's — and `template` is the one source nothing may
    // edit, so the console would refuse to let an operator change their own row.
    // The stored half is the only source for a provider rutekit did not ship.
    const curated = deps.providers.findProvider(providerId) === null;
    const manifest = curated ? deps.registry.get(providerId) : undefined;
    const templates =
      manifest === undefined
        ? []
        : manifest.models.flatMap((model) => {
            const mapped = templateModel(manifest, model.id);
            return mapped === null ? [] : [mapped];
          });

    // A stored entry whose id is already a template is the *same* model, and the
    // manifest is the authority for it — the catalogue curated it, so a row that
    // disagreed would be a second opinion nobody asked for.
    const taken = new Set(templates.map((model) => model.id));
    const stored = deps.providers
      .modelsOf(providerId)
      .filter((row) => !taken.has(row.modelId))
      .map(storedModel);

    return [...templates, ...stored];
  }

  return {
    list(query: ProvidersQuery): ProvidersResponse {
      const needle = query.q.trim().toLowerCase();
      let items = allProviders();

      if (query.category !== null) items = items.filter((entry) => entry.category === query.category);
      if (query.status !== null) items = items.filter((entry) => entry.status === query.status);
      if (query.tier === 'free') items = items.filter((entry) => entry.freeTier);
      if (query.tier === 'paid') items = items.filter((entry) => !entry.freeTier);
      if (needle !== '') {
        items = items.filter((entry) =>
          [entry.name, entry.description, entry.id].some((value) =>
            value.toLowerCase().includes(needle),
          ),
        );
      }

      const sorted = sortProviders(items, query);
      const offset = offsetOf(query.cursor);
      const next = offset + query.limit;
      return {
        items: sorted.slice(offset, next),
        nextCursor: next < sorted.length ? String(next) : null,
        total: sorted.length,
      };
    },

    detail(id: string): ProviderDetail {
      const manifest = deps.registry.get(id);
      if (manifest === undefined) throw AppError.notFound(`No provider with id ${id}.`);

      const grouped = accountsByProvider();
      const accounts = grouped.get(id) ?? [];
      const models = modelsOf(id);
      const provider = providerOf(manifest, accounts, models.length);

      return {
        provider,
        models: [...models],
        accounts: accounts.map((row) => toAccount(row, deps.pool.inFlight(row.id))),
        // Credit pools are a dashboard aggregate; this page shows the same
        // numbers the Accounts page does, so it reports none rather than a
        // second rendering of them that could disagree.
        creditPools: [],
        oauthAvailable: manifest.capabilities.oauth,
      };
    },

    models: modelsOf,

    modelCatalog(query: ModelCatalogQuery): ModelCatalogResponse {
      const needle = query.q.trim().toLowerCase();

      // The rows are the flat model list joined to its provider, because the table
      // has to name the provider on every line. Walking the registry means a model
      // whose provider is gone is absent rather than a row with a blank column.
      let items: ModelCatalogEntry[] = [];
      for (const manifest of deps.registry.all()) {
        for (const model of modelsOf(manifest.id)) {
          items.push(
            modelCatalogEntrySchema.parse({
              ...model,
              providerName: manifest.name,
              providerIcon: manifest.icon,
            }),
          );
        }
      }

      if (query.providerId !== null) {
        items = items.filter((entry) => entry.providerId === query.providerId);
      }
      if (query.source !== null) items = items.filter((entry) => entry.source === query.source);
      const floor = query.minContext;
      if (floor !== null) {
        items = items.filter(
          (entry) => entry.contextWindow !== null && entry.contextWindow >= floor,
        );
      }
      const capability = query.capability;
      if (capability !== null && isCapability(capability)) {
        items = items.filter((entry) => entry.capabilities[capability]);
      }
      if (needle !== '') {
        // The free-text filter reads the provider's name too: "which of groq's
        // models take tools" starts by typing `groq`, and a search that ignored
        // the provider column would look broken on a page that shows one.
        items = items.filter((entry) =>
          [entry.id, entry.displayName, entry.providerId, entry.providerName].some((value) =>
            value.toLowerCase().includes(needle),
          ),
        );
      }

      const sorted = sortModels(items, query);
      const offset = offsetOf(query.cursor);
      const next = offset + query.limit;
      return {
        items: sorted.slice(offset, next),
        nextCursor: next < sorted.length ? String(next) : null,
        total: sorted.length,
      };
    },

    isCurated(id: string): boolean {
      // The registry is the *merged* view, so it cannot answer this on its own —
      // asking it would call an operator's BYOK provider curated and refuse to
      // let them edit their own row. The stored half is what decides.
      return deps.providers.findProvider(id) === null && deps.registry.has(id);
    },

    manifestOf(id: string): ProviderManifest | null {
      return deps.registry.get(id) ?? null;
    },

    modelOf(providerId: string, modelId: string): ProviderModel | null {
      return modelsOf(providerId).find((model) => model.id === modelId) ?? null;
    },
  };
}

/** The account shape the console reads, without pulling the whole service in. */
function toAccount(row: ProviderAccountRow, inFlight: number): ProviderDetail['accounts'][number] {
  return {
    id: row.id,
    providerId: row.providerId,
    label: row.label,
    emailMasked: row.emailMasked,
    state: parseState(row.state),
    stateReason: row.stateReason,
    inFlight,
    maxInFlight: row.maxInFlight,
    cooldownUntil: row.cooldownUntil,
    quota: {
      windowSeconds: row.quotaWindowSeconds,
      limit: row.quotaLimit,
      remaining: row.quotaRemaining,
      resetAt: row.quotaResetAt,
      creditBalance: row.creditBalance,
      creditCurrency: row.creditCurrency,
    },
    consecutiveFailures: row.consecutiveFailures,
    lastUsedAt: row.lastUsedAt,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The four flags a model carries, as a key this file may index by. */
const CAPABILITIES = ['vision', 'tools', 'reasoning', 'embedding'] as const;

function isCapability(value: string): value is (typeof CAPABILITIES)[number] {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/** Every state the contract declares, in one place so the reader below is total. */
const ACCOUNT_STATES = ['active', 'banned', 'disabled', 'exhausted', 'error', 'pending', 'rate_limited'] as const;

type AccountStateName = (typeof ACCOUNT_STATES)[number];

/** A state the console can render, or `error` for a row edited outside rutekit. */
function parseState(value: string): AccountStateName {
  const found = ACCOUNT_STATES.find((state) => state === value);
  return found ?? 'error';
}

/**
 * The catalog's own sort.
 *
 * An absent or unrecognised `sort` leaves the catalogue's order alone — the order
 * the manifests declare, which is the order the provider files are listed in and
 * the one an operator's eye is used to.
 */
function sortProviders(rows: readonly Provider[], query: ProvidersQuery): Provider[] {
  const sorters: Readonly<Record<string, (row: Provider) => string | number>> = {
    name: (row) => row.name.toLowerCase(),
    category: (row) => row.category,
    status: (row) => row.status,
    modelCount: (row) => row.modelCount,
    accountCount: (row) => row.accountCount,
  };
  const sorter = sorters[query.sort ?? ''];
  if (sorter === undefined) return [...rows];
  return orderBy(rows, sorter, query.direction, (row) => row.id);
}

function sortModels(rows: readonly ModelCatalogEntry[], query: ModelCatalogQuery): ModelCatalogEntry[] {
  const sorters: Readonly<Record<string, (row: ModelCatalogEntry) => string | number>> = {
    id: (row) => row.id.toLowerCase(),
    displayName: (row) => row.displayName.toLowerCase(),
    providerId: (row) => row.providerId,
    contextWindow: (row) => row.contextWindow ?? 0,
  };
  const sorter = sorters[query.sort ?? ''];
  if (sorter === undefined) return [...rows];
  return orderBy(rows, sorter, query.direction, (row) => `${row.providerId}::${row.id}`);
}

/** One comparator for both lists, so a tie breaks the same way in each. */
function orderBy<TItem>(
  rows: readonly TItem[],
  sorter: (row: TItem) => string | number,
  direction: 'asc' | 'desc',
  idOf: (row: TItem) => string,
): TItem[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sorter(a);
    const right = sorter(b);
    if (left === right) return idOf(a).localeCompare(idOf(b));
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right));
    return order * sign;
  });
}

/** Cursors are plain offsets, matching what the console's pager already sends. */
function offsetOf(cursor: string | null): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** The categories a provider may declare, for a caller validating an input. */
export type { ProviderCategory };
