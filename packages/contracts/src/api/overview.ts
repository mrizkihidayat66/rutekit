import { z } from 'zod';
import { pageSchema, timeWindowSchema } from '../common.ts';
import { apiKeySchema } from '../entities/api-key.ts';
import { creditPoolSchema, systemStatusSchema } from '../entities/system.ts';
import {
  logEntrySchema,
  logKindSchema,
  logLevelSchema,
  requestLogSchema,
  usageBreakdownDimensionSchema,
  usageBreakdownRowSchema,
  usagePointSchema,
} from '../entities/usage.ts';
import { listQuerySchema } from './shared.ts';

/** Overview section: Dashboard, Usage & Metrics, Console Log. */

/* ---- Dashboard (B1) ---- */

export const dashboardSchema = z.object({
  /** The live tiles: resources, health, per-endpoint counters. */
  status: systemStatusSchema,
  /** Requests over the last 24 hours, one point per hour, for the hero chart. */
  traffic: z.array(usagePointSchema),
  providers: z.object({
    total: z.number().int().nonnegative(),
    ready: z.number().int().nonnegative(),
    needsAuth: z.number().int().nonnegative(),
    error: z.number().int().nonnegative(),
    disabled: z.number().int().nonnegative(),
  }),
  accounts: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    inFlight: z.number().int().nonnegative(),
    cooldown: z.number().int().nonnegative(),
    unhealthy: z.number().int().nonnegative(),
  }),
  /** The most recent failing requests, for the "what broke" panel. */
  recentErrors: z.array(requestLogSchema),
  /** Credit pools that refill on a schedule, shown with a countdown. */
  quotaPools: z.array(creditPoolSchema),
  /** The operator's keys, so the dashboard panel needs no second request. */
  apiKeys: z.array(apiKeySchema),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

export const lowStressBodySchema = z.object({ enabled: z.boolean() });
export type LowStressBody = z.infer<typeof lowStressBodySchema>;

/* ---- Usage & Metrics (B1) ---- */

export const usageQuerySchema = z.object({ window: timeWindowSchema.default('24h') });
export type UsageQuery = z.infer<typeof usageQuerySchema>;

/** Which counters the chart draws; the metric toggle turns these on and off. */
export const usageMetricSchema = z.enum([
  'requests',
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'costUsd',
  'errors',
]);
export type UsageMetric = z.infer<typeof usageMetricSchema>;

export const usageSeriesQuerySchema = usageQuerySchema.extend({
  metrics: z.array(usageMetricSchema).min(1).default(['requests']),
});
export type UsageSeriesQuery = z.infer<typeof usageSeriesQuerySchema>;

export const usageBreakdownQuerySchema = usageQuerySchema.extend({
  dimension: usageBreakdownDimensionSchema.default('provider'),
});
export type UsageBreakdownQuery = z.infer<typeof usageBreakdownQuerySchema>;

export const usageBreakdownResponseSchema = z.object({
  window: timeWindowSchema,
  dimension: usageBreakdownDimensionSchema,
  rows: z.array(usageBreakdownRowSchema),
});
export type UsageBreakdownResponse = z.infer<typeof usageBreakdownResponseSchema>;

/* ---- Per-request table and inspector (B1) ---- */

export const requestsQuerySchema = listQuerySchema.extend({
  window: timeWindowSchema.default('24h'),
  providerId: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  apiKeyId: z.string().nullable().default(null),
  /**
   * A tri-state rather than a boolean: `?errorsOnly=false` read as a string is
   * truthy in every naive coercion, so the filter is spelled out instead.
   */
  outcome: z.enum(['all', 'errors', 'success']).default('all'),
});
export type RequestsQuery = z.infer<typeof requestsQuerySchema>;

export const requestPayloadStageSchema = z.enum([
  'client_request',
  'canonical',
  'upstream_request',
  'upstream_response',
  'client_response',
]);
export type RequestPayloadStage = z.infer<typeof requestPayloadStageSchema>;

/**
 * One of the inspector's five payload panels. Captures are redacted server-side
 * before they are stored and expire on a TTL (SEC-6); `redacted` and `truncated`
 * are surfaced so the UI can say so rather than pretend the body is complete.
 */
export const requestPayloadPanelSchema = z.object({
  stage: requestPayloadStageSchema,
  label: z.string(),
  /** Pretty-printed JSON, already redacted; null when nothing was captured. */
  body: z.string().nullable(),
  byteSize: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
  redacted: z.boolean(),
});
export type RequestPayloadPanel = z.infer<typeof requestPayloadPanelSchema>;

/** One hop of the routing decision, in the order it was applied. */
export const routeTraceStepSchema = z.object({
  kind: z.enum(['alias', 'combo', 'mapping', 'filter', 'account']),
  label: z.string(),
  detail: z.string().nullable(),
});
export type RouteTraceStep = z.infer<typeof routeTraceStepSchema>;

/** One bar of the inspector's waterfall. */
export const requestTimelineStepSchema = z.object({
  stage: z.string(),
  /** Milliseconds from the start of the request. */
  atMs: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
});
export type RequestTimelineStep = z.infer<typeof requestTimelineStepSchema>;

export const requestDetailSchema = z.object({
  request: requestLogSchema,
  panels: z.array(requestPayloadPanelSchema),
  routeTrace: z.array(routeTraceStepSchema),
  timeline: z.array(requestTimelineStepSchema),
});
export type RequestDetail = z.infer<typeof requestDetailSchema>;

/* ---- Console Log (B1) ---- */

export const logsQuerySchema = listQuerySchema.extend({
  level: logLevelSchema.nullable().default(null),
  kind: logKindSchema.nullable().default(null),
  requestId: z.string().nullable().default(null),
  q: z.string().default(''),
});
export type LogsQuery = z.infer<typeof logsQuerySchema>;

/** Per-level totals for the level tabs, independent of the current page. */
export const logLevelCountsSchema = z.record(logLevelSchema, z.number().int().nonnegative());
export type LogLevelCounts = z.infer<typeof logLevelCountsSchema>;

export const logsResponseSchema = pageSchema(logEntrySchema).extend({
  counts: logLevelCountsSchema,
});
export type LogsResponse = z.infer<typeof logsResponseSchema>;

export const requestsResponseSchema = pageSchema(requestLogSchema);
export type RequestsResponse = z.infer<typeof requestsResponseSchema>;
