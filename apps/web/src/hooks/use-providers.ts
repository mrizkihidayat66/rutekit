import type {
  AccountInput,
  AccountUpdate,
  AccountsQuery,
  BulkAccountAction,
  ModelsQuery,
  Provider,
  ProviderInput,
  ProviderModel,
  ProviderModelInput,
  ProviderTestResult,
  ProviderUpdate,
  ProvidersQuery,
  QuotaCheckBody,
} from '@contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { queryKeys } from '@web/data/query-keys.ts';
import {
  checkQuota,
  createAccount,
  createProvider,
  createProviderModel,
  deleteAccount,
  deleteProvider,
  deleteProviderModel,
  fetchAccounts,
  fetchModels,
  fetchProviderDetail,
  fetchProviderModels,
  fetchProviders,
  fetchQuota,
  runBulkAccountAction,
  startProviderOauth,
  testProvider,
  updateAccount,
  updateProvider,
  updateProviderModel,
} from '@web/data/providers.ts';

/**
 * The Providers section's query hooks.
 *
 * The catalog and the account table are read-only lists that only move when an
 * operator acts, so they carry the same aggregate `staleTime` as the Overview
 * roll-ups. Quota is different: it is checked against the providers themselves,
 * so it is the one query here that refreshes on its own.
 *
 * Every mutation invalidates the caches it actually changed rather than the whole
 * section — adding an account must not throw away the catalog's scroll position.
 */

/** Roll-ups that only move when an operator acts. */
const AGGREGATE_STALE = 30_000;
/** A figure the provider itself owns and can change without us. */
const QUOTA_STALE = 60_000;
/** How often to re-read quota while a check-in is running. */
const CHECK_IN_POLL_MS = 1_500;

export function useProviders(query: Omit<ProvidersQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.providers(query),
    queryFn: ({ pageParam, signal }) => fetchProviders({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: AGGREGATE_STALE,
  });
}

export function useProviderDetail(id: string | null) {
  return useQuery({
    queryKey: queryKeys.provider(id ?? ''),
    queryFn: ({ signal }) => {
      if (id === null) throw new Error('useProviderDetail: queried without an id');
      return fetchProviderDetail(id, signal);
    },
    enabled: id !== null,
    staleTime: AGGREGATE_STALE,
  });
}

/**
 * The cross-provider model catalog (B2.5).
 *
 * Infinite like the other tables: the filters are what an operator scrolls
 * through, and a page is one cache entry rather than one entry per offset.
 */
export function useModels(query: Omit<ModelsQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.models(query),
    queryFn: ({ pageParam, signal }) => fetchModels({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: AGGREGATE_STALE,
  });
}

/**
 * Every model id the console knows about, for the API-key scope pickers.
 *
 * A key's allow and deny lists are written as model ids, and a name that is not
 * in the catalog is far more often a typo than a model rutekit has never heard
 * of — so the picker offers the real ids and marks anything else instead of
 * accepting it in silence. The catalog is paged and this needs all of it, so it
 * walks the pages: knowing only the first page would mark the ids beyond it as
 * unrecognised, which is the one wrong answer this is here to avoid.
 */
const MODEL_ID_QUERY: Omit<ModelsQuery, 'cursor'> = {
  q: '',
  providerId: null,
  capability: null,
  source: null,
  minContext: null,
  sort: 'displayName',
  direction: 'asc',
  limit: 200,
};

export function useModelIds(): { readonly ids: readonly string[]; readonly loading: boolean } {
  const query = useInfiniteQuery({
    queryKey: queryKeys.models(MODEL_ID_QUERY),
    queryFn: ({ pageParam, signal }) => fetchModels({ ...MODEL_ID_QUERY, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: AGGREGATE_STALE,
  });

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const ids = useMemo(() => {
    const unique = new Set<string>();
    for (const page of query.data?.pages ?? []) {
      for (const item of page.items) unique.add(item.id);
    }
    // A model id is not unique across providers, so the picker offers each one
    // once — two providers serving `gpt-4o` is still one name to type.
    return [...unique].sort((a, b) => a.localeCompare(b));
  }, [query.data]);

  return { ids, loading: query.isPending };
}

function useProviderInvalidate() {
  const client = useQueryClient();
  return (id: string) => {
    void client.invalidateQueries({ queryKey: queryKeys.provider(id) });
    void client.invalidateQueries({ queryKey: ['providers', 'list'] });
    // The catalog is a projection of every provider's model list, so a write to
    // one provider's models can change it too. Dropping it here keeps the two
    // pages from disagreeing about a row an operator just edited.
    void client.invalidateQueries({ queryKey: ['models', 'list'] });
  };
}

export function useCreateProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ProviderInput) => createProvider(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['providers', 'list'] });
    },
  });
}

/** What the BYOK wizard ends up with once an endpoint has been onboarded. */
export interface ProviderOnboarding {
  readonly provider: Provider;
  readonly models: ProviderModel[];
  readonly test: ProviderTestResult;
}

/**
 * Create a BYOK endpoint, then verify it.
 *
 * The catalog's wizard does three things in a row — save, discover the endpoint's
 * models, probe it — and they must happen in that order: the probe reports how
 * many models the endpoint lists, and a fresh provider has none until the fetch
 * has run. Sequencing them here keeps the dialog a form rather than a state
 * machine, and it means a half-finished onboarding is one mutation's failure to
 * report instead of three.
 */
export function useOnboardProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProviderInput): Promise<ProviderOnboarding> => {
      const provider = await createProvider(input);
      const { models } = await fetchProviderModels(provider.id);
      const test = await testProvider(provider.id);
      return { provider, models, test };
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['providers', 'list'] });
    },
  });
}

export function useUpdateProvider(id: string) {
  const invalidate = useProviderInvalidate();
  return useMutation({
    mutationFn: (patch: ProviderUpdate) => updateProvider(id, patch),
    onSuccess: () => {
      invalidate(id);
    },
  });
}

export function useDeleteProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteProvider(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['providers', 'list'] });
    },
  });
}

/** Probe an endpoint. A reachable-but-unauthenticated provider may flip to ready. */
export function useTestProvider(id: string) {
  const invalidate = useProviderInvalidate();
  return useMutation({
    mutationFn: () => testProvider(id),
    onSuccess: () => {
      invalidate(id);
    },
  });
}

/** Ask the endpoint for its model list, the way the BYOK wizard does. */
export function useFetchProviderModels(id: string) {
  const invalidate = useProviderInvalidate();
  return useMutation({
    mutationFn: () => fetchProviderModels(id),
    onSuccess: () => {
      invalidate(id);
    },
  });
}

/** Start an OAuth sign-in. The credential lands server-side, so only a refetch is due. */
export function useStartProviderOauth(id: string) {
  const invalidate = useProviderInvalidate();
  return useMutation({
    mutationFn: () => startProviderOauth(id),
    onSuccess: () => {
      invalidate(id);
    },
  });
}

/**
 * The three writes an operator has over a model list.
 *
 * All three move the provider's own `modelCount`, which is what the catalog card
 * reads, so each one refetches the provider as well as its detail — the same
 * invalidation the credential writes use, and for the same reason.
 */
export function useCreateProviderModel(id: string) {
  const invalidate = useProviderInvalidate();
  return useMutation({
    mutationFn: (input: ProviderModelInput) => createProviderModel(id, input),
    onSuccess: () => {
      invalidate(id);
    },
  });
}

export function useUpdateProviderModel(id: string) {
  const invalidate = useProviderInvalidate();
  return useMutation({
    mutationFn: ({ modelId, input }: { modelId: string; input: ProviderModelInput }) =>
      updateProviderModel(id, modelId, input),
    onSuccess: () => {
      invalidate(id);
    },
  });
}

export function useDeleteProviderModel(id: string) {
  const invalidate = useProviderInvalidate();
  return useMutation({
    mutationFn: (modelId: string) => deleteProviderModel(id, modelId),
    onSuccess: () => {
      invalidate(id);
    },
  });
}

export function useAccounts(query: Omit<AccountsQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.accounts(query),
    queryFn: ({ pageParam, signal }) => fetchAccounts({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: AGGREGATE_STALE,
  });
}

function useAccountInvalidate() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ['accounts', 'list'] });
    void client.invalidateQueries({ queryKey: ['providers', 'list'] });
  };
}

export function useCreateAccount() {
  const invalidate = useAccountInvalidate();
  return useMutation({
    mutationFn: (input: AccountInput) => createAccount(input),
    onSuccess: () => {
      invalidate();
    },
  });
}

export function useUpdateAccount() {
  const invalidate = useAccountInvalidate();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: AccountUpdate }) => updateAccount(id, patch),
    onSuccess: () => {
      invalidate();
    },
  });
}

export function useDeleteAccount() {
  const invalidate = useAccountInvalidate();
  return useMutation({
    mutationFn: (id: string) => deleteAccount(id),
    onSuccess: () => {
      invalidate();
    },
  });
}

export function useBulkAccountAction() {
  const invalidate = useAccountInvalidate();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (action: BulkAccountAction) => runBulkAccountAction(action),
    onSuccess: () => {
      invalidate();
      void client.invalidateQueries({ queryKey: queryKeys.quota() });
    },
  });
}

export function useQuota() {
  return useQuery({
    queryKey: queryKeys.quota(),
    queryFn: ({ signal }) => fetchQuota(signal),
    staleTime: QUOTA_STALE,
    // While a sweep is in flight somewhere, keep reading until it lands. Without
    // this the "checking" flag would arrive and then sit there until something
    // else happened to refetch — a spinner with no way to stop.
    refetchInterval: (query) =>
      query.state.data?.rows.some((row) => row.checking) === true ? CHECK_IN_POLL_MS : false,
  });
}

export function useCheckQuota() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: QuotaCheckBody) => checkQuota(body),
    onSuccess: (data) => {
      client.setQueryData(queryKeys.quota(), data);
    },
  });
}
