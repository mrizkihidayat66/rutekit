import type { LogsQuery, RequestsQuery, TimeWindow, UsageBreakdownDimension } from '@contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@web/data/query-keys.ts';
import {
  fetchDashboard,
  fetchLogs,
  fetchRequestDetail,
  fetchRequests,
  fetchUsageBreakdown,
  fetchUsageSeries,
  fetchUsageSummary,
  setLowStress,
} from '@web/data/overview.ts';

/**
 * The Overview section's query hooks.
 *
 * Every one sets an explicit `staleTime` (RULESET R6.7): a figure that changes
 * on its own — the pool's in-flight count, a live log tail — is refreshed
 * sooner than an aggregate that only moves when a request lands. `refetchOnWindowFocus`
 * stays off globally, so nothing here refetches merely because a window regained
 * focus; that decision belongs to the page.
 */

/** Status surfaces the operator watches while doing something else. */
const LIVE_STALE = 10_000;
/** Roll-ups that only move when traffic lands. */
const AGGREGATE_STALE = 30_000;
/** A tail the operator expects to keep up with. */
const TAIL_STALE = 5_000;

export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard(),
    queryFn: ({ signal }) => fetchDashboard(signal),
    staleTime: LIVE_STALE,
  });
}

export function useSetLowStress() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => setLowStress(enabled),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.dashboard() });
    },
  });
}

export function useUsageSummary(window: TimeWindow) {
  return useQuery({
    queryKey: queryKeys.usageSummary(window),
    queryFn: ({ signal }) => fetchUsageSummary(window, signal),
    staleTime: AGGREGATE_STALE,
  });
}

export function useUsageSeries(window: TimeWindow) {
  return useQuery({
    queryKey: queryKeys.usageSeries(window),
    queryFn: ({ signal }) => fetchUsageSeries(window, signal),
    staleTime: AGGREGATE_STALE,
  });
}

export function useUsageBreakdown(window: TimeWindow, dimension: UsageBreakdownDimension) {
  return useQuery({
    queryKey: queryKeys.usageBreakdown(window, dimension),
    queryFn: ({ signal }) => fetchUsageBreakdown(window, dimension, signal),
    staleTime: AGGREGATE_STALE,
  });
}

/** The per-request table, paginated by cursor. */
export function useRequests(query: Omit<RequestsQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.requests(query),
    queryFn: ({ pageParam, signal }) => fetchRequests({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: AGGREGATE_STALE,
  });
}

/** One request's five payload panels. Idle until a row is opened. */
export function useRequestDetail(id: string | null) {
  return useQuery({
    queryKey: queryKeys.request(id ?? ''),
    queryFn: ({ signal }) => {
      if (id === null) throw new Error('useRequestDetail: queried without an id');
      return fetchRequestDetail(id, signal);
    },
    enabled: id !== null,
    // A captured request is immutable; once fetched it is never stale.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * The console log tail, paginated by cursor.
 *
 * `refetchInterval` drives the page's follow switch. It is off by default, so a
 * page that is merely open does not poll (RULESET R6.7), and TanStack pauses it
 * while the tab is hidden — following resumes on the next visit rather than
 * draining the router while nobody is looking.
 */
export function useLogs(query: Omit<LogsQuery, 'cursor'>, refetchInterval: number | false = false) {
  return useInfiniteQuery({
    queryKey: queryKeys.logs(query),
    queryFn: ({ pageParam, signal }) => fetchLogs({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: TAIL_STALE,
    refetchInterval,
  });
}
