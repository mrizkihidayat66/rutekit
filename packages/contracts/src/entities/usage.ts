import { z } from 'zod';
import { isoDateTimeSchema, slugSchema, timeWindowSchema } from '../common.ts';

/** A single aggregation bucket, used by every chart on the Usage page. */
export const usagePointSchema = z.object({
  /** Bucket start, ISO-8601. */
  at: isoDateTimeSchema,
  requests: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  /** USD; 0 when the provider does not price per token. */
  costUsd: z.number().nonnegative(),
  errors: z.number().int().nonnegative(),
});

export const usageSeriesSchema = z.object({
  window: timeWindowSchema,
  points: z.array(usagePointSchema),
});

/** Aggregated totals for the currently selected window. */
export const usageSummarySchema = z.object({
  window: timeWindowSchema,
  requests: z.number().int().nonnegative(),
  successRate: z.number().min(0).max(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  /** Mean time to first token, milliseconds. Null when no streaming happened. */
  avgTtftMs: z.number().nonnegative().nullable(),
  /** Mean end-to-end latency, milliseconds. */
  avgLatencyMs: z.number().nonnegative().nullable(),
  /** Mean output tokens per second across completed streams. */
  avgTokensPerSecond: z.number().nonnegative().nullable(),
});

export const usageBreakdownDimensionSchema = z.enum([
  'provider',
  'model',
  'account',
  'apiKey',
  'status',
]);

export const usageBreakdownRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  requests: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  share: z.number().min(0).max(1),
});

/** One entry of the per-request table; also the source for the request inspector. */
export const requestLogSchema = z.object({
  id: z.string(),
  at: isoDateTimeSchema,
  method: z.string(),
  path: z.string(),
  providerId: slugSchema.nullable(),
  model: z.string().nullable(),
  accountId: z.string().nullable(),
  apiKeyId: z.string().nullable(),
  status: z.number().int().min(100).max(599),
  errorKind: z.string().nullable(),
  latencyMs: z.number().nonnegative(),
  ttftMs: z.number().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
  streamed: z.boolean(),
  /** Whether a redacted payload capture is still within its TTL (SEC-6). */
  hasCapture: z.boolean(),
});

/** Console log line, rendered by the terminal-style viewer. */
export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

export const logKindSchema = z.enum(['route', 'account', 'token', 'error', 'system']);

export const logEntrySchema = z.object({
  id: z.string(),
  at: isoDateTimeSchema,
  level: logLevelSchema,
  kind: logKindSchema,
  message: z.string(),
  requestId: z.string().nullable(),
  providerId: slugSchema.nullable(),
  accountId: z.string().nullable(),
  /** Structured extras, already redacted server-side. */
  fields: z.record(z.string(), z.string()).default({}),
});

export type UsagePoint = z.infer<typeof usagePointSchema>;
export type UsageSeries = z.infer<typeof usageSeriesSchema>;
export type UsageSummary = z.infer<typeof usageSummarySchema>;
export type UsageBreakdownDimension = z.infer<typeof usageBreakdownDimensionSchema>;
export type UsageBreakdownRow = z.infer<typeof usageBreakdownRowSchema>;
export type RequestLog = z.infer<typeof requestLogSchema>;
export type LogLevel = z.infer<typeof logLevelSchema>;
export type LogKind = z.infer<typeof logKindSchema>;
export type LogEntry = z.infer<typeof logEntrySchema>;
