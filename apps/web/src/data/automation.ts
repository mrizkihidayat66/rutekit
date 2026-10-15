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
import {
  bulkResultSchema,
  consolePath,
  consolePaths,
  jobSchema,
  jobsResponseSchema,
  okSchema,
  proxyCheckResultSchema,
  proxySchema,
  proxiesResponseSchema,
  proxiesSummarySchema,
  smsProviderCheckResultSchema,
  smsProviderSchema,
  smsProvidersResponseSchema,
  smsProvidersSummarySchema,
} from '@contracts';

import { apiDelete, apiGet, apiPatch, apiPost, withQuery } from './client.ts';

/**
 * The Automation section's requests, as plain functions.
 *
 * Two screens share this module because they are two ends of one loop: a bulk
 * import drives a browser through a provider's sign-in flow, and a proxy pool is
 * the egress those browsers leave through. A job that fails its challenge and a
 * proxy that is dead are the same class of problem for an operator, and the
 * pages that report them are read side by side.
 *
 * The jobs endpoints are the only ones in the console that stream state the
 * operator does not own — a job moves on its own while the page is open — which
 * is why `fetchJob` exists separately from the list: one job is polled while the
 * list is not.
 */

/* ---- Bulk import & job history ---- */

export function fetchJobs(query: JobsQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.jobs), {
      providerId: query.providerId,
      status: query.status,
      q: query.q,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    jobsResponseSchema,
    signal,
  );
}

export function createJob(input: JobInput, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.jobs), jobSchema, input, signal);
}

export function fetchJob(id: string, signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.job, { id }), jobSchema, signal);
}

/** The pause/resume/cancel/retry bar. Returns the job as it stands afterwards. */
export function controlJob(id: string, body: JobControlBody, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.jobControl, { id }), jobSchema, body, signal);
}

/** Answer the captcha a worker is blocked on, before its deadline passes. */
export function submitJobManual(id: string, body: JobManualBody, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.jobManual, { id }), jobSchema, body, signal);
}

/* ---- Proxy pool ---- */

export function fetchProxies(query: ProxiesQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.proxies), {
      protocol: query.protocol,
      health: query.health,
      q: query.q,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    proxiesResponseSchema,
    signal,
  );
}

/**
 * The health tallies, counted server-side.
 *
 * Counted here rather than from the loaded rows because the table is paged: a
 * tally over the first page would call a pool of two hundred "12 healthy".
 */
export function fetchProxiesSummary(signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.proxiesSummary), proxiesSummarySchema, signal);
}

export function createProxy(input: ProxyInput, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.proxies), proxySchema, input, signal);
}

/** Bulk paste. Reports per line, since one malformed row must not lose the rest. */
export function importProxies(body: ProxyImportBody, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.proxiesImport), bulkResultSchema, body, signal);
}

export function updateProxy(id: string, patch: ProxyUpdate, signal?: AbortSignal) {
  return apiPatch(consolePath(consolePaths.proxy, { id }), proxySchema, patch, signal);
}

export function deleteProxy(id: string, signal?: AbortSignal) {
  return apiDelete(consolePath(consolePaths.proxy, { id }), okSchema, signal);
}

/** An empty `ids` means "check the whole pool", the same convention quota uses. */
export function checkProxies(body: ProxyCheckBody, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.proxiesCheck), proxyCheckResultSchema, body, signal);
}

/* ---- SMS providers ---- */

export function fetchSmsProviders(query: SmsProvidersQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.smsProviders), {
      kind: query.kind,
      status: query.status,
      q: query.q,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    smsProvidersResponseSchema,
    signal,
  );
}

/**
 * Balance and reachability, tallied server-side.
 *
 * Counted on the server for the same reason the proxy tallies are: the table is
 * paged, so a client-side count would describe the first page rather than the
 * pool. A key that is out of balance is the one fact a registration job depends
 * on, and it has to be right about the whole pool.
 */
export function fetchSmsProvidersSummary(signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.smsProvidersSummary), smsProvidersSummarySchema, signal);
}

export function createSmsProvider(input: SmsProviderInput, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.smsProviders), smsProviderSchema, input, signal);
}

export function updateSmsProvider(id: string, patch: SmsProviderUpdate, signal?: AbortSignal) {
  return apiPatch(consolePath(consolePaths.smsProvider, { id }), smsProviderSchema, patch, signal);
}

export function deleteSmsProvider(id: string, signal?: AbortSignal) {
  return apiDelete(consolePath(consolePaths.smsProvider, { id }), okSchema, signal);
}

/** An empty `ids` means "check every key", the same convention proxies use. */
export function checkSmsProviders(body: SmsProviderCheckBody, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.smsProvidersCheck), smsProviderCheckResultSchema, body, signal);
}
