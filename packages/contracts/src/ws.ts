import { z } from 'zod';
import { apiErrorSchema } from './canonical.ts';
import { isoDateTimeSchema } from './common.ts';
import { accountSchema } from './entities/account.ts';
import { generationJobSchema } from './entities/asset.ts';
import { jobSchema, jobStepSchema } from './entities/job.ts';
import { systemStatusSchema } from './entities/system.ts';
import { logEntrySchema } from './entities/usage.ts';

/**
 * WebSocket transport contract (ADR-0012). Every real-time view in the dashboard
 * is fed from here — the frontend never polls. One socket carries many
 * *channels*; the client subscribes to the ones the visible page needs and
 * unsubscribes when it unmounts, so an idle tab costs nothing.
 *
 * Frames are JSON. `type` discriminates; `channel` scopes.
 */

export const wsChannelSchema = z.enum([
  'logs',
  'accounts',
  'jobs',
  'studio',
  'preview',
  'notifications',
  'system',
]);

export const wsEnvelopeSchema = z.object({
  /** Monotonic per-connection id; used for acks and for ordering assertions. */
  seq: z.number().int().nonnegative(),
  at: isoDateTimeSchema,
});

/** ---- client → server ---- */

export const wsSubscribeSchema = z.object({
  type: z.literal('subscribe'),
  channels: z.array(wsChannelSchema).min(1),
  /** Channel-scoped filter, e.g. `{ jobId }` for `jobs`. */
  filter: z.record(z.string(), z.string()).optional(),
});

export const wsUnsubscribeSchema = z.object({
  type: z.literal('unsubscribe'),
  channels: z.array(wsChannelSchema).min(1),
});

export const wsPingSchema = z.object({
  type: z.literal('ping'),
  /** Client clock, echoed back so the UI can estimate offset. */
  at: isoDateTimeSchema,
});

/** Acknowledge a notification so it stops being redelivered. */
export const wsAckSchema = z.object({
  type: z.literal('ack'),
  ids: z.array(z.string()).min(1),
});

export const wsJobControlSchema = z.object({
  type: z.literal('job_control'),
  jobId: z.string(),
  action: z.enum(['pause', 'resume', 'cancel', 'retry_failed']),
});

/**
 * The operator typed a captcha (or clicked "skip") for a job parked in
 * `needs_manual`. The server accepts this only before `manualDeadlineAt`
 * (FR-5.4, FR-5.5); afterwards the job has already moved on.
 */
export const wsManualInputSchema = z.object({
  type: z.literal('manual_input'),
  jobId: z.string(),
  workerId: z.string(),
  /** Absent when the operator chose to skip this item. */
  solution: z.string().optional(),
  skipped: z.boolean().default(false),
});

/** Cancel an in-flight studio generation. */
export const wsStudioCancelSchema = z.object({
  type: z.literal('studio_cancel'),
  generationId: z.string(),
});

export const wsClientMessageSchema = z.discriminatedUnion('type', [
  wsSubscribeSchema,
  wsUnsubscribeSchema,
  wsPingSchema,
  wsAckSchema,
  wsJobControlSchema,
  wsManualInputSchema,
  wsStudioCancelSchema,
]);

/** ---- server → client ---- */

export const wsHelloSchema = z.object({
  type: z.literal('hello'),
  connectionId: z.string(),
  /** Which channels the server accepted from the client's last subscribe. */
  channels: z.array(wsChannelSchema),
  /** Seconds the client should wait before its next ping. */
  heartbeatSeconds: z.number().int().positive(),
  serverTimeUtc: isoDateTimeSchema,
});

export const wsPongSchema = z.object({
  type: z.literal('pong'),
  /** Echo of the client's ping clock. */
  echoAt: isoDateTimeSchema,
  serverTimeUtc: isoDateTimeSchema,
});

export const wsLogAppendSchema = z.object({
  type: z.literal('log_append'),
  entries: z.array(logEntrySchema).min(1),
});

export const wsAccountUpdateSchema = z.object({
  type: z.literal('account_update'),
  /** Full replacement — the pool is small enough that deltas are not worth it. */
  accounts: z.array(accountSchema),
});

export const wsJobUpdateSchema = z.object({
  type: z.literal('job_update'),
  job: jobSchema,
});

export const wsJobStepSchema = z.object({
  type: z.literal('job_step'),
  jobId: z.string(),
  itemId: z.string(),
  step: jobStepSchema,
});

/** The server parked a worker and needs a human. Carries the deadline (FR-5.5). */
export const wsJobNeedsManualSchema = z.object({
  type: z.literal('job_needs_manual'),
  jobId: z.string(),
  workerId: z.string(),
  itemId: z.string(),
  /** Operator-readable reason, e.g. "image challenge". */
  reason: z.string(),
  /** Inline screenshot of the challenge, as a data URL. */
  screenshotUrl: z.string().nullable(),
  manualDeadlineAt: isoDateTimeSchema,
});

/** An xvfb-backed live preview frame (FR-5.10). */
export const wsPreviewFrameSchema = z.object({
  type: z.literal('preview_frame'),
  jobId: z.string(),
  workerId: z.string(),
  /** JPEG frame as a data URL; the encoder already downscaled it. */
  frameUrl: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  capturedAt: isoDateTimeSchema,
});

export const wsStudioProgressSchema = z.object({
  type: z.literal('studio_progress'),
  generation: generationJobSchema,
});

export const wsNotificationSchema = z.object({
  type: z.literal('notification'),
  notification: z.object({
    id: z.string(),
    level: z.enum(['info', 'success', 'warning', 'error']),
    title: z.string(),
    body: z.string().nullable(),
    /** Route the UI should open when the notification is clicked. */
    href: z.string().nullable(),
    at: isoDateTimeSchema,
    /** True when the client must ack; unacked notifications are redelivered. */
    requiresAck: z.boolean(),
  }),
});

export const wsSystemStatusSchema = z.object({
  type: z.literal('system_status'),
  status: systemStatusSchema,
});

export const wsErrorSchema = z.object({
  type: z.literal('error'),
  error: apiErrorSchema,
});

export const wsServerMessageSchema = z.discriminatedUnion('type', [
  wsHelloSchema,
  wsPongSchema,
  wsLogAppendSchema,
  wsAccountUpdateSchema,
  wsJobUpdateSchema,
  wsJobStepSchema,
  wsJobNeedsManualSchema,
  wsPreviewFrameSchema,
  wsStudioProgressSchema,
  wsNotificationSchema,
  wsSystemStatusSchema,
  wsErrorSchema,
]);

export type WsChannel = z.infer<typeof wsChannelSchema>;
export type WsEnvelope = z.infer<typeof wsEnvelopeSchema>;
export type WsSubscribe = z.infer<typeof wsSubscribeSchema>;
export type WsUnsubscribe = z.infer<typeof wsUnsubscribeSchema>;
export type WsPing = z.infer<typeof wsPingSchema>;
export type WsAck = z.infer<typeof wsAckSchema>;
export type WsJobControl = z.infer<typeof wsJobControlSchema>;
export type WsManualInput = z.infer<typeof wsManualInputSchema>;
export type WsStudioCancel = z.infer<typeof wsStudioCancelSchema>;
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;
export type WsHello = z.infer<typeof wsHelloSchema>;
export type WsPong = z.infer<typeof wsPongSchema>;
export type WsLogAppend = z.infer<typeof wsLogAppendSchema>;
export type WsAccountUpdate = z.infer<typeof wsAccountUpdateSchema>;
export type WsJobUpdate = z.infer<typeof wsJobUpdateSchema>;
export type WsJobStep = z.infer<typeof wsJobStepSchema>;
export type WsJobNeedsManual = z.infer<typeof wsJobNeedsManualSchema>;
export type WsPreviewFrame = z.infer<typeof wsPreviewFrameSchema>;
export type WsStudioProgress = z.infer<typeof wsStudioProgressSchema>;
export type WsNotification = z.infer<typeof wsNotificationSchema>;
export type WsSystemStatus = z.infer<typeof wsSystemStatusSchema>;
export type WsError = z.infer<typeof wsErrorSchema>;
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;
