import type {
  AccountInput,
  AccountUpdate,
  AccountsQuery,
  BulkAccountAction,
  ModelsQuery,
  ProviderInput,
  ProviderModelInput,
  ProviderUpdate,
  ProvidersQuery,
  QuotaCheckBody,
} from '@contracts';
import {
  accountSchema,
  accountsResponseSchema,
  bulkResultSchema,
  consolePath,
  consolePaths,
  modelCatalogResponseSchema,
  okSchema,
  providerDetailSchema,
  providerModelSchema,
  providerModelsResponseSchema,
  providerOauthResultSchema,
  providerSchema,
  providerTestResultSchema,
  providersResponseSchema,
  quotaOverviewSchema,
} from '@contracts';

import { apiDelete, apiGet, apiPatch, apiPost, withQuery } from './client.ts';

/**
 * The Providers section's requests, as plain functions.
 *
 * Same split as the Overview section: transport lives here, so a test can call
 * one of these without React, and the pages only ever see the hooks in
 * `@web/hooks/use-providers.ts`.
 *
 * The credential fields (`apiKey`, `credential`) appear on the input types and
 * on no read model — they are written, never read back, which is why no
 * function here returns one.
 */

export function fetchProviders(query: ProvidersQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.providers), {
      category: query.category,
      status: query.status,
      tier: query.tier === 'all' ? null : query.tier,
      q: query.q,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    providersResponseSchema,
    signal,
  );
}

export function fetchProviderDetail(id: string, signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.provider, { id }), providerDetailSchema, signal);
}

export function createProvider(input: ProviderInput, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.providers), providerSchema, input, signal);
}

export function updateProvider(id: string, patch: ProviderUpdate, signal?: AbortSignal) {
  return apiPatch(consolePath(consolePaths.provider, { id }), providerSchema, patch, signal);
}

export function deleteProvider(id: string, signal?: AbortSignal) {
  return apiDelete(consolePath(consolePaths.provider, { id }), okSchema, signal);
}

export function testProvider(id: string, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.providerTest, { id }), providerTestResultSchema, {}, signal);
}

export function fetchProviderModels(id: string, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.providerModelsFetch, { id }), providerModelsResponseSchema, {}, signal);
}

/**
 * The models an operator maintains by hand. Create and edit take the same body,
 * so the same function serves both — only the route differs, and only because an
 * edit has to name the row it is replacing.
 */
export function createProviderModel(id: string, input: ProviderModelInput, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.providerModels, { id }), providerModelSchema, input, signal);
}

export function updateProviderModel(
  id: string,
  modelId: string,
  input: ProviderModelInput,
  signal?: AbortSignal,
) {
  return apiPatch(
    consolePath(consolePaths.providerModel, { id, modelId }),
    providerModelSchema,
    input,
    signal,
  );
}

export function deleteProviderModel(id: string, modelId: string, signal?: AbortSignal) {
  return apiDelete(consolePath(consolePaths.providerModel, { id, modelId }), okSchema, signal);
}

export function startProviderOauth(id: string, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.providerOauth, { id }), providerOauthResultSchema, {}, signal);
}

/**
 * Every model from every provider, for the catalog page (B2.5).
 *
 * Read-only by design: an operator browses and copies from here, and any edit to
 * a model goes through the provider that owns it, so this has no companion write.
 */
export function fetchModels(query: ModelsQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.models), {
      providerId: query.providerId,
      capability: query.capability,
      source: query.source,
      minContext: query.minContext,
      q: query.q,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    modelCatalogResponseSchema,
    signal,
  );
}

export function fetchAccounts(query: AccountsQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.accounts), {
      providerId: query.providerId,
      state: query.state,
      q: query.q,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    accountsResponseSchema,
    signal,
  );
}

export function createAccount(input: AccountInput, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.accounts), accountSchema, input, signal);
}

export function updateAccount(id: string, patch: AccountUpdate, signal?: AbortSignal) {
  return apiPatch(consolePath(consolePaths.account, { id }), accountSchema, patch, signal);
}

export function deleteAccount(id: string, signal?: AbortSignal) {
  return apiDelete(consolePath(consolePaths.account, { id }), okSchema, signal);
}

export function runBulkAccountAction(action: BulkAccountAction, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.accountsBulk), bulkResultSchema, action, signal);
}

export function fetchQuota(signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.quota), quotaOverviewSchema, signal);
}

export function checkQuota(body: QuotaCheckBody, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.quotaCheck), quotaOverviewSchema, body, signal);
}
