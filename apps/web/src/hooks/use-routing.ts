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
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@web/data/query-keys.ts';
import {
  createAlias,
  createApiKey,
  createCombo,
  createFilterRule,
  createMapping,
  deleteAlias,
  deleteApiKey,
  deleteCombo,
  deleteFilterRule,
  deleteMapping,
  fetchAliases,
  fetchApiKeys,
  fetchCombos,
  fetchFilterRules,
  fetchMappings,
  previewMapping,
  revokeApiKey,
  updateAlias,
  updateApiKey,
  updateCombo,
  updateFilterRule,
  updateMapping,
} from '@web/data/routing.ts';

/**
 * The Routing section's query hooks.
 *
 * Everything on these four screens is configuration: it changes when an operator
 * changes it and at no other time, so the lists carry the same aggregate
 * `staleTime` the catalog does rather than polling. The one exception is the
 * mapping preview, which is not a read at all — it is a mutation that happens to
 * return a value, and it is modelled that way so a keystroke cannot land in the
 * cache under a key something else reads.
 *
 * API-key writes are the one place this section reaches outside itself: the
 * dashboard's payload carries the same key list, so a new or revoked key would
 * otherwise sit stale on the overview until its own `staleTime` elapsed.
 */

/** Configuration only moves when an operator acts. */
const CONFIG_STALE = 30_000;

function useListInvalidate(scope: string) {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: [scope, 'list'] });
  };
}

/* ---- Combos ---- */

export function useCombos(query: Omit<SearchQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.combos(query),
    queryFn: ({ pageParam, signal }) => fetchCombos({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: CONFIG_STALE,
  });
}

export function useCreateCombo() {
  const invalidate = useListInvalidate('combos');
  return useMutation({
    mutationFn: (input: ComboInput) => createCombo(input),
    onSuccess: invalidate,
  });
}

export function useUpdateCombo() {
  const invalidate = useListInvalidate('combos');
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ComboUpdate }) => updateCombo(id, patch),
    onSuccess: invalidate,
  });
}

export function useDeleteCombo() {
  const invalidate = useListInvalidate('combos');
  return useMutation({
    mutationFn: (id: string) => deleteCombo(id),
    onSuccess: invalidate,
  });
}

/* ---- Aliases ---- */

export function useAliases(query: Omit<SearchQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.aliases(query),
    queryFn: ({ pageParam, signal }) => fetchAliases({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: CONFIG_STALE,
  });
}

export function useCreateAlias() {
  const invalidate = useListInvalidate('aliases');
  return useMutation({
    mutationFn: (input: AliasInput) => createAlias(input),
    onSuccess: invalidate,
  });
}

export function useUpdateAlias() {
  const invalidate = useListInvalidate('aliases');
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: AliasUpdate }) => updateAlias(id, patch),
    onSuccess: invalidate,
  });
}

export function useDeleteAlias() {
  const invalidate = useListInvalidate('aliases');
  return useMutation({
    mutationFn: (id: string) => deleteAlias(id),
    onSuccess: invalidate,
  });
}

/* ---- Model mapping ---- */

export function useMappings(query: Omit<SearchQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.mappings(query),
    queryFn: ({ pageParam, signal }) => fetchMappings({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: CONFIG_STALE,
  });
}

export function useCreateMapping() {
  const invalidate = useListInvalidate('mappings');
  return useMutation({
    mutationFn: (input: MappingInput) => createMapping(input),
    onSuccess: invalidate,
  });
}

export function useUpdateMapping() {
  const invalidate = useListInvalidate('mappings');
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: MappingUpdate }) => updateMapping(id, patch),
    onSuccess: invalidate,
  });
}

export function useDeleteMapping() {
  const invalidate = useListInvalidate('mappings');
  return useMutation({
    mutationFn: (id: string) => deleteMapping(id),
    onSuccess: invalidate,
  });
}

/** Dry-run a draft rule against sample model ids. Writes nothing. */
export function usePreviewMapping() {
  return useMutation({
    mutationFn: (body: MappingPreviewBody) => previewMapping(body),
  });
}

/* ---- Filter rules ---- */

export function useFilterRules(query: Omit<SearchQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.filterRules(query),
    queryFn: ({ pageParam, signal }) => fetchFilterRules({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: CONFIG_STALE,
  });
}

export function useCreateFilterRule() {
  const invalidate = useListInvalidate('filter-rules');
  return useMutation({
    mutationFn: (input: FilterRuleInput) => createFilterRule(input),
    onSuccess: invalidate,
  });
}

export function useUpdateFilterRule() {
  const invalidate = useListInvalidate('filter-rules');
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: FilterRuleUpdate }) =>
      updateFilterRule(id, patch),
    onSuccess: invalidate,
  });
}

export function useDeleteFilterRule() {
  const invalidate = useListInvalidate('filter-rules');
  return useMutation({
    mutationFn: (id: string) => deleteFilterRule(id),
    onSuccess: invalidate,
  });
}

/* ---- API keys ---- */

export function useApiKeys(query: Omit<ApiKeysQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.apiKeys(query),
    queryFn: ({ pageParam, signal }) => fetchApiKeys({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: CONFIG_STALE,
  });
}

function useApiKeyInvalidate() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ['api-keys', 'list'] });
    void client.invalidateQueries({ queryKey: queryKeys.dashboard() });
  };
}

export function useCreateApiKey() {
  const invalidate = useApiKeyInvalidate();
  return useMutation({
    mutationFn: (input: ApiKeyInput) => createApiKey(input),
    onSuccess: invalidate,
  });
}

export function useUpdateApiKey() {
  const invalidate = useApiKeyInvalidate();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ApiKeyUpdate }) => updateApiKey(id, patch),
    onSuccess: invalidate,
  });
}

export function useRevokeApiKey() {
  const invalidate = useApiKeyInvalidate();
  return useMutation({
    mutationFn: (id: string) => revokeApiKey(id),
    onSuccess: invalidate,
  });
}

export function useDeleteApiKey() {
  const invalidate = useApiKeyInvalidate();
  return useMutation({
    mutationFn: (id: string) => deleteApiKey(id),
    onSuccess: invalidate,
  });
}
