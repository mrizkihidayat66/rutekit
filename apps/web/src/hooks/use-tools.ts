import type {
  BenchmarkInput,
  ChatSessionInput,
  ChatSessionUpdate,
  ChatSessionsQuery,
  DotTrickBody,
  StudioAssetUpdate,
  StudioAssetsQuery,
  StudioGenerateBody,
  StudioGenerationsQuery,
  VccCardUpdate,
  VccCardsQuery,
  VccGenerateBody,
  VerificationInput,
  VerificationsQuery,
} from '@contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@web/data/query-keys.ts';
import {
  createBenchmark,
  createChatSession,
  createStudioGeneration,
  createVerification,
  deleteChatSession,
  deleteStudioAsset,
  fetchBenchmark,
  fetchBenchmarks,
  fetchChatSession,
  fetchChatSessions,
  fetchStudioAsset,
  fetchStudioAssets,
  fetchStudioGeneration,
  fetchStudioGenerations,
  fetchVccBins,
  fetchVccCard,
  fetchVccCards,
  fetchVerification,
  fetchVerifications,
  generateVccCards,
  runDotTrick,
  updateChatSession,
  updateStudioAsset,
  updateVccCard,
} from '@web/data/tools.ts';

/**
 * The Tools section's query hooks.
 *
 * Three of these poll and the rest do not, and the split is the whole design:
 * a *generation* and a *benchmark run* are the two things in this section that
 * move while the operator watches, so they carry a refetch interval; a
 * verification result is a finished measurement and a VCC card only changes when
 * somebody edits it, so those are read once and left alone.
 *
 * The chat session is the odd one out: it changes constantly while a reply
 * streams, but the reply arrives over the WebSocket, so there is nothing to
 * poll — the socket writes into this cache directly.
 */

/** Roll-ups that only move when an operator acts. */
const AGGREGATE_STALE = 30_000;
/** Curated reference data — it changes when the app is redeployed, not at runtime. */
const REFERENCE_STALE = 5 * 60_000;
/** How often to re-read something that is still working. */
const WORK_POLL_MS = 2_000;

/** A generation in one of these states is going to change on its own. */
const LIVE_GENERATION_STATUSES: readonly string[] = ['queued', 'executing', 'progress'];
/** A benchmark run in one of these is still filling in its cells. */
const LIVE_BENCHMARK_STATUSES: readonly string[] = ['queued', 'running'];

/* ---- Chat ---- */

export function useChatSessions(query: Omit<ChatSessionsQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.chatSessions(query),
    queryFn: ({ pageParam, signal }) => fetchChatSessions({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: AGGREGATE_STALE,
  });
}

/**
 * One session, with its messages.
 *
 * Not polled: an assistant turn arrives over the `chat` channel as it streams,
 * so the socket is what keeps this fresh. Polling here would race the stream and
 * repaint the transcript from underneath it.
 */
export function useChatSession(id: string | null) {
  return useQuery({
    queryKey: queryKeys.chatSession(id ?? ''),
    queryFn: ({ signal }) => {
      if (id === null) throw new Error('useChatSession: queried without an id');
      return fetchChatSession(id, signal);
    },
    enabled: id !== null,
    staleTime: 0,
  });
}

export function useCreateChatSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ChatSessionInput) => createChatSession(input),
    onSuccess: (session) => {
      void client.invalidateQueries({ queryKey: ['chat', 'sessions'] });
      client.setQueryData(queryKeys.chatSession(session.id), session);
    },
  });
}

export function useUpdateChatSession(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: ChatSessionUpdate) => updateChatSession(id, patch),
    onSuccess: (session) => {
      client.setQueryData(queryKeys.chatSession(id), session);
      void client.invalidateQueries({ queryKey: ['chat', 'sessions'] });
    },
  });
}

export function useDeleteChatSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteChatSession(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['chat', 'sessions'] });
    },
  });
}

/* ---- Studio ---- */

export function useStudioAssets(query: Omit<StudioAssetsQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.studioAssets(query),
    queryFn: ({ pageParam, signal }) => fetchStudioAssets({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: AGGREGATE_STALE,
  });
}

export function useStudioAsset(id: string | null) {
  return useQuery({
    queryKey: queryKeys.studioAsset(id ?? ''),
    queryFn: ({ signal }) => {
      if (id === null) throw new Error('useStudioAsset: queried without an id');
      return fetchStudioAsset(id, signal);
    },
    enabled: id !== null,
    staleTime: AGGREGATE_STALE,
  });
}

/**
 * The generation queue, polled while anything in it is still working.
 *
 * The interval is decided from the last page rather than from a prop, so it
 * stops on its own once every job has landed — the gallery is the way an
 * operator watches a prompt turn into a picture, and it should stop asking once
 * there is nothing left to watch.
 */
export function useStudioGenerations(query: Omit<StudioGenerationsQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.studioGenerations(query),
    queryFn: ({ pageParam, signal }) =>
      fetchStudioGenerations({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: 0,
    refetchInterval: (query) => {
      const pages = query.state.data?.pages;
      if (pages === undefined) return false;
      const live = pages.some((page) =>
        page.items.some((job) => LIVE_GENERATION_STATUSES.includes(job.status)),
      );
      return live ? WORK_POLL_MS : false;
    },
  });
}

/** One generation, polled for as long as it is still moving. */
export function useStudioGeneration(id: string | null) {
  return useQuery({
    queryKey: queryKeys.studioGeneration(id ?? ''),
    queryFn: ({ signal }) => {
      if (id === null) throw new Error('useStudioGeneration: queried without an id');
      return fetchStudioGeneration(id, signal);
    },
    enabled: id !== null,
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status !== undefined && LIVE_GENERATION_STATUSES.includes(status)
        ? WORK_POLL_MS
        : false;
    },
  });
}

function useStudioInvalidate() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ['studio', 'generations'] });
    void client.invalidateQueries({ queryKey: ['studio', 'assets'] });
  };
}

/** Queue a batch. The jobs come back `queued`; the gallery fills in after. */
export function useCreateStudioGeneration() {
  const invalidate = useStudioInvalidate();
  return useMutation({
    mutationFn: (body: StudioGenerateBody) => createStudioGeneration(body),
    onSuccess: () => {
      invalidate();
    },
  });
}

export function useUpdateStudioAsset() {
  const invalidate = useStudioInvalidate();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: StudioAssetUpdate }) =>
      updateStudioAsset(id, patch),
    onSuccess: () => {
      invalidate();
    },
  });
}

export function useDeleteStudioAsset() {
  const invalidate = useStudioInvalidate();
  return useMutation({
    mutationFn: (id: string) => deleteStudioAsset(id),
    onSuccess: () => {
      invalidate();
    },
  });
}

/* ---- Benchmark ---- */

export function useBenchmarks(query: Omit<ChatSessionsQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.benchmarks(query),
    queryFn: ({ pageParam, signal }) => fetchBenchmarks({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: AGGREGATE_STALE,
  });
}

/** One run, polled while its cells are still being filled in. */
export function useBenchmark(id: string | null) {
  return useQuery({
    queryKey: queryKeys.benchmark(id ?? ''),
    queryFn: ({ signal }) => {
      if (id === null) throw new Error('useBenchmark: queried without an id');
      return fetchBenchmark(id, signal);
    },
    enabled: id !== null,
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status !== undefined && LIVE_BENCHMARK_STATUSES.includes(status) ? WORK_POLL_MS : false;
    },
  });
}

export function useCreateBenchmark() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: BenchmarkInput) => createBenchmark(input),
    onSuccess: (run) => {
      void client.invalidateQueries({ queryKey: ['benchmarks', 'list'] });
      client.setQueryData(queryKeys.benchmark(run.id), run);
    },
  });
}

/* ---- Model Verification ---- */

export function useVerifications(query: Omit<VerificationsQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.verifications(query),
    queryFn: ({ pageParam, signal }) => fetchVerifications({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: AGGREGATE_STALE,
  });
}

/**
 * One verification result.
 *
 * Not polled. A verification is a bounded batch of probes that has already
 * finished by the time it is stored — unlike a generation, there is no partial
 * state to watch, so re-reading it would only cost requests.
 */
export function useVerification(id: string | null) {
  return useQuery({
    queryKey: queryKeys.verification(id ?? ''),
    queryFn: ({ signal }) => {
      if (id === null) throw new Error('useVerification: queried without an id');
      return fetchVerification(id, signal);
    },
    enabled: id !== null,
    staleTime: AGGREGATE_STALE,
  });
}

export function useCreateVerification() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: VerificationInput) => createVerification(input),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['verifications', 'list'] });
      client.setQueryData(queryKeys.verification(result.id), result);
    },
  });
}

/* ---- Dot trick ---- */

/**
 * Expand an address into its variants.
 *
 * A mutation rather than a query even though it reads nothing, because it is
 * driven by a button and the result is a thing the operator asked for once, not
 * a piece of server state that should live in the cache and refresh itself.
 */
export function useDotTrick() {
  return useMutation({
    mutationFn: (body: DotTrickBody) => runDotTrick(body),
  });
}

/* ---- VCC pool ---- */

export function useVccCards(query: Omit<VccCardsQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.vccCards(query),
    queryFn: ({ pageParam, signal }) => fetchVccCards({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: AGGREGATE_STALE,
  });
}

export function useVccCard(id: string | null) {
  return useQuery({
    queryKey: queryKeys.vccCard(id ?? ''),
    queryFn: ({ signal }) => {
      if (id === null) throw new Error('useVccCard: queried without an id');
      return fetchVccCard(id, signal);
    },
    enabled: id !== null,
    staleTime: AGGREGATE_STALE,
  });
}

export function useGenerateVccCards() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: VccGenerateBody) => generateVccCards(body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['vcc', 'list'] });
    },
  });
}

/**
 * The issuer ranges a batch can be minted under.
 *
 * Read once and kept: the catalogue is curated rather than discovered, so it
 * cannot change between two opens of the generate dialog.
 */
export function useVccBins() {
  return useQuery({
    queryKey: queryKeys.vccBins(),
    queryFn: ({ signal }) => fetchVccBins(signal),
    staleTime: REFERENCE_STALE,
  });
}

export function useUpdateVccCard() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: VccCardUpdate }) => updateVccCard(id, patch),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['vcc', 'list'] });
    },
  });
}
