import { z } from 'zod';
import { isoDateTimeSchema, slugSchema } from '../common.ts';

/**
 * Automation job lifecycle (FR-5.x). `needs_manual` is the state that keeps a
 * job alive while an operator solves a captcha — it is *not* a failure (FR-5.4).
 */
export const jobStatusSchema = z.enum([
  'queued',
  'running',
  'needs_manual',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
]);

export const jobStepStatusSchema = z.enum(['pending', 'running', 'ok', 'failed', 'skipped']);

export const browserEngineSchema = z.enum(['chromium', 'camoufox']);

/**
 * How a job gets the credentials it is importing. The method is not a preference
 * — it is the shape of the work, and it decides which options the job even has:
 * a `bulk-login` drives a browser through a sign-in page, a `bulk-regist` rents
 * a phone number and creates the account, and a `bulk-token` posts tokens that
 * were already issued and opens nothing at all.
 *
 * Providers differ in which of the three they offer, so the method is chosen per
 * job rather than declared per provider (FR-5.x).
 */
export const jobMethodSchema = z.enum(['bulk-login', 'bulk-regist', 'bulk-token']);

/** Whether the browser a job drives draws a window. Headless is the default. */
export const jobModeSchema = z.enum(['headed', 'headless']);

/** One reported step of a job, streamed to the UI as it happens (FR-5.12). */
export const jobStepSchema = z.object({
  id: z.string(),
  /** Monotonic index used for stable ordering and the timeline UI. */
  index: z.number().int().nonnegative(),
  name: z.string(),
  status: jobStepStatusSchema,
  /** Operator-readable detail, e.g. "captcha marker detected". */
  detail: z.string().nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  /** Id of an inline screenshot captured at this step, if any. */
  screenshotId: z.string().nullable(),
});

export const jobItemSchema = z.object({
  id: z.string(),
  /** Masked identifier for the account being imported, e.g. `a***@gmail.com`. */
  accountLabel: z.string(),
  status: jobStatusSchema,
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  lastError: z.string().nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  steps: z.array(jobStepSchema),
});

export const jobSchema = z.object({
  id: z.string(),
  providerId: slugSchema,
  method: jobMethodSchema,
  /** Null for a method that never opens a browser, such as a token import. */
  engine: browserEngineSchema.nullable(),
  /** Null when there is no browser to draw a window for. */
  mode: jobModeSchema.nullable(),
  /** The egress the browsers left through, or null when none was pinned. */
  proxyId: z.string().nullable(),
  status: jobStatusSchema,
  /** What the operator asked for. The machine may hold it lower (FR-5.8). */
  concurrency: z.number().int().positive(),
  /**
   * What the job is actually running at, when the machine held it down.
   *
   * Null when the requested number was granted, which is the ordinary case. A
   * silent cap is worse than no cap — an operator who asked for eight and got two
   * reads the slowness as a provider problem — so when the two differ, this is
   * what says so.
   */
  effectiveConcurrency: z.number().int().positive().nullable().default(null),
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** Count currently waiting on a human. */
  needsManual: z.number().int().nonnegative(),
  /** Which worker is awaiting a human, when exactly one is. */
  manualWorkerId: z.string().nullable(),
  /** Deadline after which a manual session is abandoned and the job moves on (FR-5.5). */
  manualDeadlineAt: isoDateTimeSchema.nullable(),
  items: z.array(jobItemSchema),
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
});

export const proxyProtocolSchema = z.enum(['http', 'https', 'socks5']);

export const proxyHealthSchema = z.enum(['healthy', 'slow', 'dead', 'untested']);

export const proxySchema = z.object({
  id: z.string(),
  protocol: proxyProtocolSchema,
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  /** Credentials are write-only; the read model never returns them. */
  hasAuth: z.boolean(),
  health: proxyHealthSchema,
  latencyMs: z.number().nonnegative().nullable(),
  lastCheckedAt: isoDateTimeSchema.nullable(),
  /** Number of dispatches routed through this proxy in the current window. */
  dispatchCount: z.number().int().nonnegative(),
  note: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type JobStatus = z.infer<typeof jobStatusSchema>;
export type JobStepStatus = z.infer<typeof jobStepStatusSchema>;
export type BrowserEngine = z.infer<typeof browserEngineSchema>;
export type JobMethod = z.infer<typeof jobMethodSchema>;
export type JobMode = z.infer<typeof jobModeSchema>;
export type JobStep = z.infer<typeof jobStepSchema>;
export type JobItem = z.infer<typeof jobItemSchema>;
export type Job = z.infer<typeof jobSchema>;
export type ProxyProtocol = z.infer<typeof proxyProtocolSchema>;
export type ProxyHealth = z.infer<typeof proxyHealthSchema>;
export type Proxy = z.infer<typeof proxySchema>;
