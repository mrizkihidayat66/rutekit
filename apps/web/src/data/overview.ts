import type { LogsQuery, RequestsQuery, TimeWindow, UsageBreakdownDimension } from '@contracts';
import {
  consolePath,
  consolePaths,
  dashboardSchema,
  logsResponseSchema,
  okSchema,
  requestDetailSchema,
  requestsResponseSchema,
  usageBreakdownResponseSchema,
  usageSeriesSchema,
  usageSummarySchema,
} from '@contracts';

import { apiGet, apiPost, withQuery } from './client.ts';

/**
 * The Overview section's requests, as plain functions.
 *
 * They are kept apart from the hooks in `@web/hooks/use-overview.ts` so the
 * transport can be exercised without React: a test can call `fetchLogs` and
 * assert the contract holds, and a page only ever sees a hook.
 */

export function fetchDashboard(signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.dashboard), dashboardSchema, signal);
}

export function fetchUsageSummary(window: TimeWindow, signal?: AbortSignal) {
  return apiGet(withQuery(consolePath(consolePaths.usageSummary), { window }), usageSummarySchema, signal);
}

export function fetchUsageSeries(window: TimeWindow, signal?: AbortSignal) {
  return apiGet(withQuery(consolePath(consolePaths.usageSeries), { window }), usageSeriesSchema, signal);
}

export function fetchUsageBreakdown(
  window: TimeWindow,
  dimension: UsageBreakdownDimension,
  signal?: AbortSignal,
) {
  return apiGet(
    withQuery(consolePath(consolePaths.usageBreakdown), { window, dimension }),
    usageBreakdownResponseSchema,
    signal,
  );
}

export function fetchRequests(query: RequestsQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.requests), {
      window: query.window,
      providerId: query.providerId,
      model: query.model,
      apiKeyId: query.apiKeyId,
      outcome: query.outcome,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    requestsResponseSchema,
    signal,
  );
}

export function fetchRequestDetail(id: string, signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.request, { id }), requestDetailSchema, signal);
}

export function fetchLogs(query: LogsQuery, signal?: AbortSignal) {
  return apiGet(
    withQuery(consolePath(consolePaths.logs), {
      level: query.level,
      kind: query.kind,
      requestId: query.requestId,
      q: query.q,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      cursor: query.cursor,
    }),
    logsResponseSchema,
    signal,
  );
}

export function setLowStress(enabled: boolean, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.lowStress), okSchema, { enabled }, signal);
}
