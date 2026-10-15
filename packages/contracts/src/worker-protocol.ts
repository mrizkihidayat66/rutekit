import { z } from 'zod';
import { slugSchema } from './common.ts';
import { browserEngineSchema, jobMethodSchema, jobModeSchema } from './entities/job.ts';

/**
 * The stdio protocol between the server and the automation worker (ADR-0009).
 *
 * One JSON object per line, both directions, validated at both ends (R1.7). It
 * lives in `contracts` rather than in either process because that is the whole
 * point of the boundary rule: the host and the worker are two runtimes, and a
 * protocol that only one of them describes is a protocol that drifts.
 *
 * **A job is one worker, and the worker runs its own items.** That is what makes
 * this protocol small: the host says "here is a job", the worker walks its items
 * with its own concurrency, and reports what happened. The host never tells a
 * worker to start item seven, because the worker already knows how to get there —
 * and a worker that had to be driven item by item would put the retry loop, the
 * backoff and the item ordering in the process that cannot see the browser.
 *
 * Four messages go the other way because there are four things a worker cannot
 * decide alone:
 *
 *   - `manual-answer` — only the operator has the captcha text.
 *   - `abandon-item` — the deadline is the host's clock (see below).
 *   - `cancel` — the operator pressed pause or cancel.
 *   - `shutdown` — the host is draining.
 *
 * **The host holds the manual deadline.** A worker reports `needs-manual` and
 * then waits; the host sets `manualDeadlineAt`, tells the console, and sends
 * `abandon-item` when it passes. Two clocks counting the same interval would be
 * two clocks that can disagree — the countdown the operator watches and the one
 * that decides must be the same one.
 *
 * Nothing here carries a credential *back* except in `item-done`, which is the
 * one place it belongs: obtaining the credential is the job.
 */

/* ---- What the host tells the worker to do ---- */

/** One item the worker is asked to import, with whatever it needs to do it. */
export const workerItemSchema = z.object({
  id: z.string(),
  /** What the console shows. Already masked; the worker never needs the raw form. */
  label: z.string(),
  /** `email:password` for a sign-in, a token for a token import, null to register. */
  credential: z.string().nullable().default(null),
});

/**
 * The egress the worker's browsers leave through, already decrypted.
 *
 * The worker is a separate process with no database and no key, so the host
 * resolves the proxy before handing the job over. The credential travels in the
 * URL's authority, which is where a proxy client expects it.
 */
export const workerProxySchema = z.object({
  url: z.string(),
});

/** The number-rental key a registration job draws from, already decrypted. */
export const workerSmsSchema = z.object({
  kind: z.string(),
  apiKey: z.string(),
  country: z.string().nullable().default(null),
  operator: z.string().nullable().default(null),
  product: z.string().nullable().default(null),
});

/** Where the provider's sign-in starts, and what the flow expects to meet. */
export const workerAutomationSchema = z.object({
  login: z.enum(['browser', 'device-code']),
  startUrl: z.string(),
  captcha: z.boolean(),
  humanTimeoutSeconds: z.number().int().positive(),
});

/** Everything a worker needs, resolved. Self-contained on purpose. */
export const workerJobSchema = z.object({
  jobId: z.string(),
  providerId: slugSchema,
  method: jobMethodSchema,
  engine: browserEngineSchema.nullable().default(null),
  mode: jobModeSchema.nullable().default(null),
  concurrency: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  /** Null when the provider declares no automation block. */
  automation: workerAutomationSchema.nullable().default(null),
  proxy: workerProxySchema.nullable().default(null),
  sms: workerSmsSchema.nullable().default(null),
  items: z.array(workerItemSchema),
});

export const workerStartSchema = z.object({
  type: z.literal('start'),
  workerId: z.string(),
  job: workerJobSchema,
});

/** Stop everything. The worker's browsers are closed and it exits. */
export const workerCancelSchema = z.object({
  type: z.literal('cancel'),
  workerId: z.string(),
});

/** The operator's answer to a challenge. The worker resumes that item. */
export const workerManualAnswerSchema = z.object({
  type: z.literal('manual-answer'),
  workerId: z.string(),
  itemId: z.string(),
  solution: z.string(),
});

/**
 * The operator has opened a manual session on this item (FR-5.7).
 *
 * Not an answer — the beginning of one. The worker re-captures the page and
 * reports the challenge again, which is what refreshes the console's view and
 * restarts the deadline. Without it, an operator who opens a session a minute
 * before the deadline gets a minute to work, which is the wrong thing to give
 * somebody who has just sat down.
 */
export const workerManualOpenSchema = z.object({
  type: z.literal('manual-open'),
  workerId: z.string(),
  itemId: z.string(),
});

/**
 * Give up on one item and carry on with the rest (FR-5.5).
 *
 * Sent when the host's manual deadline passes. Distinct from `cancel`, which
 * stops the job: this is the deadline doing its job, and the batch continues.
 */
export const workerAbandonItemSchema = z.object({
  type: z.literal('abandon-item'),
  workerId: z.string(),
  itemId: z.string(),
});

/** Finish gracefully: no new items, current ones abandoned, exit 0. */
export const workerShutdownSchema = z.object({
  type: z.literal('shutdown'),
  workerId: z.string(),
});

export const hostToWorkerSchema = z.discriminatedUnion('type', [
  workerStartSchema,
  workerCancelSchema,
  workerManualAnswerSchema,
  workerManualOpenSchema,
  workerAbandonItemSchema,
  workerShutdownSchema,
]);

/* ---- What the worker tells the host ---- */

/**
 * The worker is up and waiting for `start`.
 *
 * The host waits for this before sending the job, so a spawn that failed to load
 * its own modules is a failure the host hears about rather than a job that sits
 * `running` with nobody behind it.
 */
export const workerReadySchema = z.object({
  type: z.literal('ready'),
  workerId: z.string(),
});

/** One step of one item, streamed as it happens (FR-5.12). */
export const workerStepSchema = z.object({
  type: z.literal('step'),
  workerId: z.string(),
  itemId: z.string(),
  /** Monotonic per item; the console uses it for stable ordering. */
  index: z.number().int().nonnegative(),
  name: z.string(),
  status: z.enum(['running', 'ok', 'failed', 'skipped']),
  detail: z.string().nullable().default(null),
});

/** A periodic frame of the worker's display (FR-5.2). */
export const workerScreenshotSchema = z.object({
  type: z.literal('screenshot'),
  workerId: z.string(),
  /** Null while the job is between items and no browser is focused. */
  itemId: z.string().nullable().default(null),
  /** JPEG as a data URL; the worker has already downscaled it. */
  frameUrl: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/**
 * A challenge the worker cannot pass, handed to a human (FR-5.3, FR-5.4).
 *
 * Not a failure. The worker keeps the browser open, mid-flow, and waits for
 * either an answer or an `abandon-item`. The host sets the deadline; the worker
 * only says how long the provider's own flow allows.
 */
export const workerNeedsManualSchema = z.object({
  type: z.literal('needs-manual'),
  workerId: z.string(),
  itemId: z.string(),
  /** Operator-readable, e.g. "image challenge". */
  reason: z.string(),
  /** Inline screenshot of the challenge, as a data URL. */
  screenshotUrl: z.string().nullable().default(null),
  humanTimeoutSeconds: z.number().int().positive(),
});

/**
 * One item imported successfully.
 *
 * `credential` is the thing the whole job exists to produce — an API key, a
 * token pair, a session cookie — and it is the only credential that travels
 * *from* the worker. The host stores it as a provider account.
 */
export const workerItemDoneSchema = z.object({
  type: z.literal('item-done'),
  workerId: z.string(),
  itemId: z.string(),
  /** The provider account's credential blob, as the account store expects it. */
  credential: z.string(),
  /** The account's masked identity, for the row. */
  label: z.string(),
});

/** One item that will not succeed. `retryable` is the worker's own verdict. */
export const workerItemFailedSchema = z.object({
  type: z.literal('item-failed'),
  workerId: z.string(),
  itemId: z.string(),
  error: z.string(),
  attempts: z.number().int().nonnegative(),
});

/** The job is over. The host closes its books. */
export const workerDoneSchema = z.object({
  type: z.literal('done'),
  workerId: z.string(),
});

/**
 * The worker could not run the job at all.
 *
 * Job-level, not item-level: a missing browser binary or an unusable proxy is a
 * failure of the whole batch, and `retryable` says whether another run could
 * plausibly go differently.
 */
export const workerFailedSchema = z.object({
  type: z.literal('failed'),
  workerId: z.string(),
  error: z.string(),
  retryable: z.boolean(),
});

export const workerToHostSchema = z.discriminatedUnion('type', [
  workerReadySchema,
  workerStepSchema,
  workerScreenshotSchema,
  workerNeedsManualSchema,
  workerItemDoneSchema,
  workerItemFailedSchema,
  workerDoneSchema,
  workerFailedSchema,
]);

export type WorkerItem = z.infer<typeof workerItemSchema>;
export type WorkerProxy = z.infer<typeof workerProxySchema>;
export type WorkerSms = z.infer<typeof workerSmsSchema>;
export type WorkerAutomation = z.infer<typeof workerAutomationSchema>;
export type WorkerJob = z.infer<typeof workerJobSchema>;
export type WorkerStart = z.infer<typeof workerStartSchema>;
export type WorkerCancel = z.infer<typeof workerCancelSchema>;
export type WorkerManualAnswer = z.infer<typeof workerManualAnswerSchema>;
export type WorkerManualOpen = z.infer<typeof workerManualOpenSchema>;
export type WorkerAbandonItem = z.infer<typeof workerAbandonItemSchema>;
export type WorkerShutdown = z.infer<typeof workerShutdownSchema>;
export type HostToWorker = z.infer<typeof hostToWorkerSchema>;
export type WorkerToHost = z.infer<typeof workerToHostSchema>;
export type WorkerReady = z.infer<typeof workerReadySchema>;
export type WorkerStep = z.infer<typeof workerStepSchema>;
export type WorkerScreenshot = z.infer<typeof workerScreenshotSchema>;
export type WorkerNeedsManual = z.infer<typeof workerNeedsManualSchema>;
export type WorkerItemDone = z.infer<typeof workerItemDoneSchema>;
export type WorkerItemFailed = z.infer<typeof workerItemFailedSchema>;
export type WorkerDone = z.infer<typeof workerDoneSchema>;
export type WorkerFailed = z.infer<typeof workerFailedSchema>;
