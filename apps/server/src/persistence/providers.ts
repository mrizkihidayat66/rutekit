import { and, asc, eq } from 'drizzle-orm';

import type { Db } from './client.ts';
import { providerModels, providers } from './schema.ts';

/**
 * Providers an operator configured, and the models that are not the catalogue's
 * (C13a, FR-2.4–2.6).
 *
 * Two repositories in one file because they are one feature: a BYOK provider and
 * the models it serves. The catalogue's own providers and models are manifests
 * and never appear here — this file is only ever the *operator's* half, which is
 * what keeps `PATCH` and `DELETE` a question with an obvious answer.
 *
 * **`replaceSynced` replaces a provider's synced entries in one transaction.**
 * A fetch that wrote half the list and then failed would leave a model set that
 * is neither what the endpoint said before nor what it says now, and the console
 * would show it as the current truth. Custom entries are untouched: they are the
 * operator's, and a fetch is not a statement about them.
 */

export type ProviderRow = typeof providers.$inferSelect;
export type ProviderInsert = typeof providers.$inferInsert;
export type ProviderModelRow = typeof providerModels.$inferSelect;
export type ProviderModelInsert = typeof providerModels.$inferInsert;

/** The fields of a BYOK provider an operator may change. */
export interface ProviderPatch {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly category?: string | undefined;
  readonly wireFamily?: string | undefined;
  readonly baseUrl?: string | null | undefined;
  readonly docsUrl?: string | null | undefined;
  readonly icon?: string | undefined;
}

export interface ProviderRepository {
  /* ---- providers ---- */

  createProvider(record: ProviderInsert): ProviderRow;
  findProvider(id: string): ProviderRow | null;
  listProviders(): ProviderRow[];
  updateProvider(id: string, patch: ProviderPatch, updatedAt: string): void;
  /** Delete a provider and its model rows together. */
  deleteProvider(id: string): void;

  /* ---- models ---- */

  /** Every stored model, for the catalog's join. */
  listModels(): ProviderModelRow[];
  modelsOf(providerId: string): ProviderModelRow[];
  findModel(providerId: string, modelId: string): ProviderModelRow | null;
  putModel(record: ProviderModelInsert): ProviderModelRow;
  deleteModel(providerId: string, modelId: string): void;
  /**
   * Replace a provider's `synced` entries with what its endpoint just answered.
   *
   * Custom entries are left alone — they are the operator's, and a fetch says
   * nothing about them.
   */
  replaceSynced(providerId: string, records: readonly ProviderModelInsert[]): void;
}

export interface ProviderRepositoryDeps {
  readonly db: Db;
}

export function createProviderRepository(deps: ProviderRepositoryDeps): ProviderRepository {
  return {
    createProvider(record: ProviderInsert): ProviderRow {
      const row = deps.db.insert(providers).values(record).returning().get();
      if (row === undefined) throw new Error('the inserted provider could not be read back');
      return row;
    },

    findProvider(id: string): ProviderRow | null {
      return deps.db.select().from(providers).where(eq(providers.id, id)).get() ?? null;
    },

    listProviders(): ProviderRow[] {
      // Catalogue order for a console list is the *caller's* job — this answers
      // in insertion order, and the service sorts by name.
      return deps.db.select().from(providers).orderBy(asc(providers.id)).all();
    },

    updateProvider(id: string, patch: ProviderPatch, updatedAt: string): void {
      const set: Partial<ProviderInsert> = { updatedAt };
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.category !== undefined) set.category = patch.category;
      if (patch.wireFamily !== undefined) set.wireFamily = patch.wireFamily;
      if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl;
      if (patch.docsUrl !== undefined) set.docsUrl = patch.docsUrl;
      if (patch.icon !== undefined) set.icon = patch.icon;
      deps.db.update(providers).set(set).where(eq(providers.id, id)).run();
    },

    deleteProvider(id: string): void {
      // One transaction: a provider without its models is a row whose detail page
      // lists nothing, and a model without its provider is a catalog entry with a
      // blank name column.
      deps.db.transaction((tx) => {
        tx.delete(providerModels).where(eq(providerModels.providerId, id)).run();
        tx.delete(providers).where(eq(providers.id, id)).run();
      });
    },

    listModels(): ProviderModelRow[] {
      return deps.db.select().from(providerModels).all();
    },

    modelsOf(providerId: string): ProviderModelRow[] {
      return deps.db
        .select()
        .from(providerModels)
        .where(eq(providerModels.providerId, providerId))
        .orderBy(asc(providerModels.modelId))
        .all();
    },

    findModel(providerId: string, modelId: string): ProviderModelRow | null {
      return (
        deps.db
          .select()
          .from(providerModels)
          .where(
            and(eq(providerModels.providerId, providerId), eq(providerModels.modelId, modelId)),
          )
          .get() ?? null
      );
    },

    putModel(record: ProviderModelInsert): ProviderModelRow {
      // `onConflictDoUpdate` rather than insert-or-update by hand: a rename writes
      // the new id and deletes the old, and the two have to land together — a
      // crash between them would leave the model listed twice.
      const row = deps.db
        .insert(providerModels)
        .values(record)
        .onConflictDoUpdate({
          target: [providerModels.providerId, providerModels.modelId],
          set: {
            source: record.source,
            displayName: record.displayName,
            contextWindow: record.contextWindow ?? null,
            maxOutputTokens: record.maxOutputTokens ?? null,
            capabilities: record.capabilities,
            inputPricePerMTok: record.inputPricePerMTok ?? null,
            outputPricePerMTok: record.outputPricePerMTok ?? null,
            deprecated: record.deprecated ?? false,
            updatedAt: record.updatedAt,
          },
        })
        .returning()
        .get();
      if (row === undefined) throw new Error('the stored model could not be read back');
      return row;
    },

    deleteModel(providerId: string, modelId: string): void {
      deps.db
        .delete(providerModels)
        .where(
          and(eq(providerModels.providerId, providerId), eq(providerModels.modelId, modelId)),
        )
        .run();
    },

    replaceSynced(providerId: string, records: readonly ProviderModelInsert[]): void {
      deps.db.transaction((tx) => {
        tx.delete(providerModels)
          .where(
            and(eq(providerModels.providerId, providerId), eq(providerModels.source, 'synced')),
          )
          .run();
        for (const record of records) {
          tx.insert(providerModels).values(record).run();
        }
      });
    },
  };
}

