import type {
  AliasInput,
  AliasUpdate,
  ApiKeyInput,
  ApiKeyUpdate,
  ApiKeysQuery,
  ComboInput,
  ComboUpdate,
  FilterRuleInput,
  FilterRuleUpdate,
  MappingInput,
  MappingPreviewBody,
  MappingUpdate,
  SearchQuery,
} from '@contracts';
import {
  aliasSchema,
  aliasesResponseSchema,
  apiKeyCreatedSchema,
  apiKeySchema,
  apiKeysResponseSchema,
  comboSchema,
  combosResponseSchema,
  consolePath,
  consolePaths,
  filterRuleSchema,
  filterRulesResponseSchema,
  mappingPreviewResultSchema,
  mappingsResponseSchema,
  modelMappingRuleSchema,
  okSchema,
} from '@contracts';

import { apiDelete, apiGet, apiPatch, apiPost, withQuery } from './client.ts';

/**
 * The Routing section's requests, as plain functions.
 *
 * Four screens share this module because they share one idea: a request arrives
 * naming a model, and something here decides what happens to it. A filter rule is
 * the earliest decision of all — it reads the request as it arrived and either
 * stops it or rewrites what matched, before any routing has happened. After that
 * a mapping renames the model at the edge, an alias resolves a friendly name to
 * the same thing, and a combo fans out to candidates; an API key is the caller
 * the whole decision is made on behalf of. Keeping them in one file makes that
 * ordering visible instead of hiding it behind four near-identical modules.
 *
 * The list endpoints all take the shared `SearchQuery`; the filters a page adds
 * on top (enabled-only, state) are applied where the endpoint does not accept
 * them, which is why `state` is the only one that reaches the wire.
 */

/* ---- Combos ---- */

export function fetchCombos(query: SearchQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.combos), {
      q: query.q,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    combosResponseSchema,
    signal,
  );
}

export function createCombo(input: ComboInput, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.combos), comboSchema, input, signal);
}

export function updateCombo(id: string, patch: ComboUpdate, signal?: AbortSignal) {
  return apiPatch(consolePath(consolePaths.combo, { id }), comboSchema, patch, signal);
}

export function deleteCombo(id: string, signal?: AbortSignal) {
  return apiDelete(consolePath(consolePaths.combo, { id }), okSchema, signal);
}

/* ---- Aliases ---- */

export function fetchAliases(query: SearchQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.aliases), {
      q: query.q,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    aliasesResponseSchema,
    signal,
  );
}

export function createAlias(input: AliasInput, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.aliases), aliasSchema, input, signal);
}

export function updateAlias(id: string, patch: AliasUpdate, signal?: AbortSignal) {
  return apiPatch(consolePath(consolePaths.alias, { id }), aliasSchema, patch, signal);
}

export function deleteAlias(id: string, signal?: AbortSignal) {
  return apiDelete(consolePath(consolePaths.alias, { id }), okSchema, signal);
}

/* ---- Model mapping ---- */

export function fetchMappings(query: SearchQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.mappings), {
      q: query.q,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    mappingsResponseSchema,
    signal,
  );
}

export function createMapping(input: MappingInput, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.mappings), modelMappingRuleSchema, input, signal);
}

export function updateMapping(id: string, patch: MappingUpdate, signal?: AbortSignal) {
  return apiPatch(consolePath(consolePaths.mapping, { id }), modelMappingRuleSchema, patch, signal);
}

export function deleteMapping(id: string, signal?: AbortSignal) {
  return apiDelete(consolePath(consolePaths.mapping, { id }), okSchema, signal);
}

/**
 * Run a rule that has not been saved yet against sample model ids.
 *
 * This is a POST rather than a GET because the rule travels in the body and a
 * regex is not something to put in a query string, but it writes nothing — the
 * preview panel can call it on every keystroke without leaving a trace.
 */
export function previewMapping(body: MappingPreviewBody, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.mappingsPreview), mappingPreviewResultSchema, body, signal);
}

/* ---- Filter rules ---- */

export function fetchFilterRules(query: SearchQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.filterRules), {
      q: query.q,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    filterRulesResponseSchema,
    signal,
  );
}

export function createFilterRule(input: FilterRuleInput, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.filterRules), filterRuleSchema, input, signal);
}

export function updateFilterRule(id: string, patch: FilterRuleUpdate, signal?: AbortSignal) {
  return apiPatch(consolePath(consolePaths.filterRule, { id }), filterRuleSchema, patch, signal);
}

export function deleteFilterRule(id: string, signal?: AbortSignal) {
  return apiDelete(consolePath(consolePaths.filterRule, { id }), okSchema, signal);
}

/* ---- API keys ---- */

export function fetchApiKeys(query: ApiKeysQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.apiKeys), {
      state: query.state,
      q: query.q,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    apiKeysResponseSchema,
    signal,
  );
}

/** Returns the secret alongside the key. It is the only time the secret exists. */
export function createApiKey(input: ApiKeyInput, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.apiKeys), apiKeyCreatedSchema, input, signal);
}

export function updateApiKey(id: string, patch: ApiKeyUpdate, signal?: AbortSignal) {
  return apiPatch(consolePath(consolePaths.apiKey, { id }), apiKeySchema, patch, signal);
}

export function revokeApiKey(id: string, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.apiKeyRevoke, { id }), apiKeySchema, {}, signal);
}

export function deleteApiKey(id: string, signal?: AbortSignal) {
  return apiDelete(consolePath(consolePaths.apiKey, { id }), okSchema, signal);
}
