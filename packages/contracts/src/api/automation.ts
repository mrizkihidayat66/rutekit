import { z } from 'zod';
import { pageSchema, slugSchema } from '../common.ts';
import {
  browserEngineSchema,
  jobMethodSchema,
  jobModeSchema,
  jobSchema,
  jobStatusSchema,
  proxyHealthSchema,
  proxyProtocolSchema,
  proxySchema,
} from '../entities/job.ts';
import {
  smsProviderKindSchema,
  smsProviderSchema,
  smsProviderStatusSchema,
} from '../entities/sms-provider.ts';
import { searchQuerySchema, updateSchema } from './shared.ts';

/** Automation section: Automation, Automation Logs, Proxy Pool, SMS Providers. */

/* ---- Bulk Import / Automation Logs (B4) ---- */

export const jobsQuerySchema = searchQuerySchema.extend({
  providerId: z.string().nullable().default(null),
  status: jobStatusSchema.nullable().default(null),
});
export type JobsQuery = z.infer<typeof jobsQuerySchema>;

export const jobsResponseSchema = pageSchema(jobSchema);
export type JobsResponse = z.infer<typeof jobsResponseSchema>;

/** The pause/resume/cancel/retry bar on a running job. */
export const jobControlBodySchema = z.object({
  action: z.enum(['pause', 'resume', 'cancel', 'retry_failed']),
});
export type JobControlBody = z.infer<typeof jobControlBodySchema>;

/**
 * The manual hand-off: a job sitting in `needs_manual` waits for an operator to
 * solve a captcha and post the answer here before its deadline (FR-5.4/5.5).
 * `itemId` targets the one worker that is blocked when several are running.
 */
export const jobManualBodySchema = z.object({
  itemId: z.string(),
  /** The operator's answer, e.g. the captcha text or the clicked tile order. */
  solution: z.string().min(1),
});
export type JobManualBody = z.infer<typeof jobManualBodySchema>;

/**
 * Open a manual session on one item (FR-5.7).
 *
 * Not an answer — the operator saying they are taking it over. The worker
 * re-captures the page and reports the challenge again, which refreshes the
 * console's frame and restarts the deadline. Without it, somebody who sits down
 * to a challenge a minute before the deadline gets a minute to solve it.
 */
export const jobSessionBodySchema = z.object({ itemId: z.string() });
export type JobSessionBody = z.infer<typeof jobSessionBodySchema>;

/**
 * Launch an automation job.
 *
 * One body covers all three methods because they differ only in which fields
 * carry meaning — and which those are is decided by `method`, not by the body's
 * shape. A `bulk-login` reads `payload` as credentials and pins a browser; a
 * `bulk-regist` ignores `payload`, rents numbers through `smsProviderId` and
 * creates `quantity` accounts; a `bulk-token` reads `payload` as issued tokens
 * and opens nothing, so every browser field is null.
 *
 * The browser fields are nullable rather than absent so a stored job can be read
 * back without knowing which method produced it.
 */
export const jobInputSchema = z.object({
  providerId: slugSchema,
  method: jobMethodSchema,
  /** Null for `bulk-token`, which never opens a browser. */
  engine: browserEngineSchema.nullable().default(null),
  /** Null whenever `engine` is. */
  mode: jobModeSchema.nullable().default(null),
  concurrency: z.number().int().positive().default(1),
  /** Egress from the proxy pool, or null to leave the choice to the router. */
  proxyId: z.string().nullable().default(null),
  /** Credentials for `bulk-login`, tokens for `bulk-token`, empty for `bulk-regist`. */
  payload: z.string().default(''),
  maxAttempts: z.number().int().positive().default(3),
  /** `bulk-regist` only: the key that rents the numbers. */
  smsProviderId: z.string().nullable().default(null),
  /** `bulk-regist` only: how many accounts to create. */
  quantity: z.number().int().positive().nullable().default(null),
  /** `bulk-regist` only: overrides for the key's own last-used triple. */
  country: z.string().nullable().default(null),
  operator: z.string().nullable().default(null),
  product: z.string().nullable().default(null),
});
export type JobInput = z.infer<typeof jobInputSchema>;

/* ---- Proxy Pool (B4) ---- */

export const proxiesQuerySchema = searchQuerySchema.extend({
  protocol: proxyProtocolSchema.nullable().default(null),
  health: proxyHealthSchema.nullable().default(null),
});
export type ProxiesQuery = z.infer<typeof proxiesQuerySchema>;

export const proxiesResponseSchema = pageSchema(proxySchema);
export type ProxiesResponse = z.infer<typeof proxiesResponseSchema>;

/** Proxy credentials are write-only, exactly like provider and account ones. */
export const proxyInputSchema = z.object({
  protocol: proxyProtocolSchema.default('http'),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().nullable().default(null),
  password: z.string().nullable().default(null),
  note: z.string().nullable().default(null),
});
export type ProxyInput = z.infer<typeof proxyInputSchema>;

export const proxyUpdateSchema = updateSchema(proxyInputSchema.shape);
export type ProxyUpdate = z.infer<typeof proxyUpdateSchema>;

/** Bulk-paste import: one `protocol://user:pass@host:port` per line. */
export const proxyImportBodySchema = z.object({ payload: z.string().min(1) });
export type ProxyImportBody = z.infer<typeof proxyImportBodySchema>;

/** An empty list means "check every proxy", the same convention as quota. */
export const proxyCheckBodySchema = z.object({
  ids: z.array(z.string()).default([]),
});
export type ProxyCheckBody = z.infer<typeof proxyCheckBodySchema>;

export const proxyCheckResultSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      health: proxyHealthSchema,
      latencyMs: z.number().nonnegative().nullable(),
    }),
  ),
});
export type ProxyCheckResult = z.infer<typeof proxyCheckResultSchema>;

export const proxiesSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  healthy: z.number().int().nonnegative(),
  slow: z.number().int().nonnegative(),
  dead: z.number().int().nonnegative(),
  untested: z.number().int().nonnegative(),
});
export type ProxiesSummary = z.infer<typeof proxiesSummarySchema>;

/* ---- SMS providers (B4) ---- */

export const smsProvidersQuerySchema = searchQuerySchema.extend({
  kind: smsProviderKindSchema.nullable().default(null),
  status: smsProviderStatusSchema.nullable().default(null),
});
export type SmsProvidersQuery = z.infer<typeof smsProvidersQuerySchema>;

export const smsProvidersResponseSchema = pageSchema(smsProviderSchema);
export type SmsProvidersResponse = z.infer<typeof smsProvidersResponseSchema>;

/**
 * The key is write-only, exactly like a proxy password or a provider secret: it
 * is accepted on the way in and never returned. `country`/`operator`/`product`
 * are the last triple the key worked with, so a registration job can default to
 * it instead of asking the operator to retype something that already succeeded.
 */
export const smsProviderInputSchema = z.object({
  kind: smsProviderKindSchema.default('5sim'),
  label: z.string().min(1),
  apiKey: z.string().min(1),
  country: z.string().nullable().default(null),
  operator: z.string().nullable().default(null),
  product: z.string().nullable().default(null),
  note: z.string().nullable().default(null),
});
export type SmsProviderInput = z.infer<typeof smsProviderInputSchema>;

export const smsProviderUpdateSchema = updateSchema(smsProviderInputSchema.shape);
export type SmsProviderUpdate = z.infer<typeof smsProviderUpdateSchema>;

/** An empty list means "check every key", the same convention proxies use. */
export const smsProviderCheckBodySchema = z.object({
  ids: z.array(z.string()).default([]),
});
export type SmsProviderCheckBody = z.infer<typeof smsProviderCheckBodySchema>;

export const smsProviderCheckResultSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      status: smsProviderStatusSchema,
      balance: z.number().nonnegative().nullable(),
      currency: z.string().nullable(),
    }),
  ),
});
export type SmsProviderCheckResult = z.infer<typeof smsProviderCheckResultSchema>;

export const smsProvidersSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  disabled: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
  untested: z.number().int().nonnegative(),
  /** Numbers rented across the pool, and how many of those never delivered. */
  successCount: z.number().int().nonnegative(),
  failCount: z.number().int().nonnegative(),
});
export type SmsProvidersSummary = z.infer<typeof smsProvidersSummarySchema>;
