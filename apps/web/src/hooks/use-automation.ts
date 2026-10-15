import type {
  JobControlBody,
  JobInput,
  JobManualBody,
  JobsQuery,
  ProxiesQuery,
  ProxyCheckBody,
  ProxyImportBody,
  ProxyInput,
  ProxyUpdate,
  SmsProviderCheckBody,
  SmsProviderInput,
  SmsProviderUpdate,
  SmsProvidersQuery,
} from '@contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  checkProxies,
  checkSmsProviders,
  controlJob,
  createJob,
  createProxy,
  createSmsProvider,
  deleteProxy,
  deleteSmsProvider,
  fetchJob,
  fetchJobs,
  fetchProxies,
  fetchProxiesSummary,
  fetchSmsProviders,
  fetchSmsProvidersSummary,
  importProxies,
  submitJobManual,
  updateProxy,
  updateSmsProvider,
} from '@web/data/automation.ts';
import { queryKeys } from '@web/data/query-keys.ts';

/**
 * The Automation section's query hooks.
 *
 * The two lists here are the only ones in the console whose contents move
 * without an operator: a job walks through its steps on its own, and a proxy's
 * health changes when something checks it. Everything else the dashboard shows
 * only changes when a person acts on it, which is why those pages carry a plain
 * `staleTime` and these carry a poll.
 *
 * The poll is attached to a single job rather than to the list. A running job is
 * one row the operator is watching; refetching the whole history every couple of
 * seconds to update that row would throw away the list's scroll position for no
 * gain.
 */

/** Roll-ups that only move when an operator acts. */
const AGGREGATE_STALE = 30_000;
/** How often to re-read a job that is still moving. */
const JOB_POLL_MS = 2_000;

/** A job in one of these states is going to change on its own. */
const LIVE_JOB_STATUSES: readonly string[] = ['queued', 'running', 'needs_manual'];

/* ---- Jobs ---- */

export function useJobs(query: Omit<JobsQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.jobs(query),
    queryFn: ({ pageParam, signal }) => fetchJobs({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: AGGREGATE_STALE,
  });
}

/**
 * One job, kept fresh while it is still doing something.
 *
 * A finished job is a record and is not re-read; a live one is polled so the
 * step timeline and the manual deadline stay honest without the operator
 * reloading. The interval is decided from the last response rather than from a
 * prop, so it stops on its own the moment the job lands.
 */
export function useJob(id: string | null) {
  return useQuery({
    queryKey: queryKeys.job(id ?? ''),
    queryFn: ({ signal }) => {
      if (id === null) throw new Error('useJob: queried without an id');
      return fetchJob(id, signal);
    },
    enabled: id !== null,
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status !== undefined && LIVE_JOB_STATUSES.includes(status) ? JOB_POLL_MS : false;
    },
  });
}

function useJobInvalidate(id: string) {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: queryKeys.job(id) });
    void client.invalidateQueries({ queryKey: ['jobs', 'list'] });
  };
}

/**
 * Launch a bulk import.
 *
 * The list is invalidated but not the new job's own key: nothing has read it
 * yet, and the page that launched it navigates to the job it just created.
 */
export function useCreateJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: JobInput) => createJob(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['jobs', 'list'] });
    },
  });
}

/** Pause, resume, cancel, or requeue the failures. */
export function useJobControl(id: string) {
  const invalidate = useJobInvalidate(id);
  return useMutation({
    mutationFn: (body: JobControlBody) => controlJob(id, body),
    onSuccess: () => {
      invalidate();
    },
  });
}

/** Hand a blocked worker the captcha answer it is waiting on. */
export function useSubmitJobManual(id: string) {
  const invalidate = useJobInvalidate(id);
  return useMutation({
    mutationFn: (body: JobManualBody) => submitJobManual(id, body),
    onSuccess: () => {
      invalidate();
    },
  });
}

/* ---- Proxy pool ---- */

export function useProxies(query: Omit<ProxiesQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.proxies(query),
    queryFn: ({ pageParam, signal }) => fetchProxies({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: AGGREGATE_STALE,
  });
}

export function useProxiesSummary() {
  return useQuery({
    queryKey: queryKeys.proxiesSummary(),
    queryFn: ({ signal }) => fetchProxiesSummary(signal),
    staleTime: AGGREGATE_STALE,
  });
}

function useProxyInvalidate() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ['proxies', 'list'] });
    void client.invalidateQueries({ queryKey: queryKeys.proxiesSummary() });
  };
}

export function useCreateProxy() {
  const invalidate = useProxyInvalidate();
  return useMutation({
    mutationFn: (input: ProxyInput) => createProxy(input),
    onSuccess: () => {
      invalidate();
    },
  });
}

/** Bulk paste. The report comes back per line, so the form can list what failed. */
export function useImportProxies() {
  const invalidate = useProxyInvalidate();
  return useMutation({
    mutationFn: (body: ProxyImportBody) => importProxies(body),
    onSuccess: () => {
      invalidate();
    },
  });
}

export function useUpdateProxy() {
  const invalidate = useProxyInvalidate();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: ProxyUpdate }) => updateProxy(id, patch),
    onSuccess: () => {
      invalidate();
    },
  });
}

export function useDeleteProxy() {
  const invalidate = useProxyInvalidate();
  return useMutation({
    mutationFn: (id: string) => deleteProxy(id),
    onSuccess: () => {
      invalidate();
    },
  });
}

/**
 * Delete a whole selection.
 *
 * There is no bulk endpoint for proxies, so this is one request per id, all in
 * flight together. They are settled rather than awaited in sequence so one
 * refusal — a proxy somebody else already removed — does not abandon the rest of
 * the selection, and the report says how many did not go through.
 */
export function useDeleteProxies() {
  const invalidate = useProxyInvalidate();
  return useMutation({
    mutationFn: async (ids: readonly string[]) => {
      const settled = await Promise.allSettled(ids.map((id) => deleteProxy(id)));
      return { requested: ids.length, failed: settled.filter((r) => r.status === 'rejected').length };
    },
    onSuccess: () => {
      invalidate();
    },
  });
}

/**
 * Re-check proxies and write the results back.
 *
 * The check returns what it found, but the rows it changed live in the list and
 * the tallies in the summary, so both are dropped rather than patched from the
 * response — the response says only what was checked, not what the pool now
 * holds.
 */
export function useCheckProxies() {
  const invalidate = useProxyInvalidate();
  return useMutation({
    mutationFn: (body: ProxyCheckBody) => checkProxies(body),
    onSuccess: () => {
      invalidate();
    },
  });
}

/* ---- SMS providers ---- */

export function useSmsProviders(query: Omit<SmsProvidersQuery, 'cursor'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.smsProviders(query),
    queryFn: ({ pageParam, signal }) => fetchSmsProviders({ ...query, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: AGGREGATE_STALE,
  });
}

/**
 * The balance and tally roll-up.
 *
 * Balance is the number a registration job's next attempt depends on, so this
 * shares the proxies' short stale time rather than the longer one a static
 * record would use — a key that ran dry an hour ago should not read as funded.
 */
export function useSmsProvidersSummary() {
  return useQuery({
    queryKey: queryKeys.smsProvidersSummary(),
    queryFn: ({ signal }) => fetchSmsProvidersSummary(signal),
    staleTime: AGGREGATE_STALE,
  });
}

function useSmsProviderInvalidate() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: ['sms-providers', 'list'] });
    void client.invalidateQueries({ queryKey: queryKeys.smsProvidersSummary() });
  };
}

export function useCreateSmsProvider() {
  const invalidate = useSmsProviderInvalidate();
  return useMutation({
    mutationFn: (input: SmsProviderInput) => createSmsProvider(input),
    onSuccess: () => {
      invalidate();
    },
  });
}

export function useUpdateSmsProvider() {
  const invalidate = useSmsProviderInvalidate();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: SmsProviderUpdate }) =>
      updateSmsProvider(id, patch),
    onSuccess: () => {
      invalidate();
    },
  });
}

export function useDeleteSmsProvider() {
  const invalidate = useSmsProviderInvalidate();
  return useMutation({
    mutationFn: (id: string) => deleteSmsProvider(id),
    onSuccess: () => {
      invalidate();
    },
  });
}

/** Delete a whole selection, one request per id, settled rather than sequential. */
export function useDeleteSmsProviders() {
  const invalidate = useSmsProviderInvalidate();
  return useMutation({
    mutationFn: async (ids: readonly string[]) => {
      const settled = await Promise.allSettled(ids.map((id) => deleteSmsProvider(id)));
      return { requested: ids.length, failed: settled.filter((r) => r.status === 'rejected').length };
    },
    onSuccess: () => {
      invalidate();
    },
  });
}

/** Re-read balances from the activation service and write them back. */
export function useCheckSmsProviders() {
  const invalidate = useSmsProviderInvalidate();
  return useMutation({
    mutationFn: (body: SmsProviderCheckBody) => checkSmsProviders(body),
    onSuccess: () => {
      invalidate();
    },
  });
}
