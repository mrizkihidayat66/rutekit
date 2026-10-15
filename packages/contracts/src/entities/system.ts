import { z } from 'zod';
import { healthStateSchema, isoDateTimeSchema } from '../common.ts';

/** Process and host resource counters shown on the Dashboard (FR: B1 Dashboard). */
export const systemResourcesSchema = z.object({
  memoryUsedBytes: z.number().int().nonnegative(),
  memoryTotalBytes: z.number().int().nonnegative(),
  cpuPercent: z.number().min(0).max(100),
  uptimeSeconds: z.number().int().nonnegative(),
  /** SQLite file size plus generated assets. */
  diskUsedBytes: z.number().int().nonnegative(),
  nodeVersion: z.string(),
  bunVersion: z.string(),
  platform: z.string(),
});

/** One aggregated health tile on the Dashboard. */
export const systemHealthTileSchema = z.object({
  id: z.string(),
  label: z.string(),
  state: healthStateSchema,
  /** Short human-readable value, e.g. "42 ms" or "3 / 8 healthy". */
  value: z.string(),
  detail: z.string().nullable(),
});

export const endpointStatusSchema = z.object({
  surface: z.enum(['chat/completions', 'messages', 'responses', 'completions', 'models']),
  enabled: z.boolean(),
  requestsLastHour: z.number().int().nonnegative(),
  errorsLastHour: z.number().int().nonnegative(),
  /** Mean latency over the last hour, milliseconds. */
  avgLatencyMs: z.number().nonnegative().nullable(),
});

export const systemStatusSchema = z.object({
  version: z.string(),
  startedAt: isoDateTimeSchema,
  /** Server clock in UTC, rendered in the shell footer. */
  serverTimeUtc: isoDateTimeSchema,
  resources: systemResourcesSchema,
  health: z.array(systemHealthTileSchema),
  endpoints: z.array(endpointStatusSchema),
  /** When true, routing prefers cheap/fast paths over best-quality ones. */
  lowStressMode: z.boolean(),
});

/** A pool of interchangeable credentials offered by a provider (FR: provider detail). */
export const creditPoolSchema = z.object({
  providerId: z.string(),
  label: z.string(),
  totalCredits: z.number().nonnegative(),
  usedCredits: z.number().nonnegative(),
  /** Seconds until the pool refills; null when it does not. */
  resetInSeconds: z.number().int().nonnegative().nullable(),
  resetAt: isoDateTimeSchema.nullable(),
  currency: z.string().nullable(),
});

export const themeSchema = z.enum(['light', 'dark', 'system']);

export const glassDepthSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

/**
 * Operator appearance settings. Backgrounds accept an image *or* a video, which
 * is what makes the customization page more than a theme switcher.
 */
export const customizationSchema = z.object({
  theme: themeSchema,
  brandingIconUrl: z.string().nullable(),
  backgroundKind: z.enum(['none', 'image', 'video']),
  backgroundUrl: z.string().nullable(),
  backgroundOpacity: z.number().min(0).max(1),
  backgroundBlurPx: z.number().min(0).max(64),
  glassEnabled: z.boolean(),
  glassDepth: glassDepthSchema,
  ambientGlow: z.boolean(),
});

export const generalSettingsSchema = z.object({
  instanceName: z.string(),
  lowStressMode: z.boolean(),
  telemetryRetentionMinutes: z.number().int().positive(),
  /** Payload captures are redacted and expire (SEC-6). */
  payloadCaptureEnabled: z.boolean(),
  payloadCaptureTtlMinutes: z.number().int().positive(),
  defaultProviderId: z.string().nullable(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']),
});

/** Auth state for the single-user dashboard (D8). */
export const authStatusSchema = z.object({
  /** False before the first-run wizard completes. */
  configured: z.boolean(),
  authenticated: z.boolean(),
  sessionExpiresAt: isoDateTimeSchema.nullable(),
});

export const backupManifestSchema = z.object({
  version: z.string(),
  createdAt: isoDateTimeSchema,
  includesCredentials: z.boolean(),
  tableCounts: z.record(z.string(), z.number().int().nonnegative()),
});

/**
 * One table's rows, as they were stored.
 *
 * `z.unknown()` per value rather than a typed shape per table: the archive is a
 * dump, and a contract that enumerated every column of twenty-seven tables would
 * be a second schema to keep in step with `schema.ts` — one that would have to
 * change with every migration. What the restore validates is the *identifiers* (a
 * table rutekit knows, a column that table actually has) and the binding of every
 * value as a parameter, which is where the safety actually lives.
 */
const archivedRowsSchema = z.array(z.record(z.string(), z.unknown()));

/**
 * The archive an export produces and a restore consumes (SEC-6).
 *
 * **`schemaVersion` is the reason an archive can refuse to be restored.** It
 * records the migration the data was written at, and a restore into an *older*
 * instance is refused rather than attempted: the older build does not know what a
 * newer column means, and the honest answer is a refusal rather than a
 * half-written row.
 *
 * **`omitted` is part of the format, not decoration.** An archive that quietly
 * lacks the operator's password and their sessions would be a file that claims to
 * be complete, and the next person to open it would have to read the code to find
 * out it is not. Naming what was left out and why makes the archive explain
 * itself.
 *
 * `format` is separate from `schemaVersion` on purpose: one is the shape of the
 * file, the other is the shape of the database inside it. A future change to how
 * archives are written must not be confused with a migration.
 */
export const backupArchiveSchema = z.object({
  format: z.literal(1),
  /** The migration the data was written at. Restoring into an older build is refused. */
  schemaVersion: z.number().int().nonnegative(),
  /** The rutekit build that wrote it, for the record. */
  version: z.string(),
  createdAt: isoDateTimeSchema,
  includesCredentials: z.boolean(),
  /** Table name → rows. Only tables rutekit knows and may restore. */
  tables: z.record(z.string(), archivedRowsSchema),
  /** What was left out, and why — so the archive explains itself. */
  omitted: z.array(z.object({ table: z.string(), reason: z.string() })),
});
export type BackupArchive = z.infer<typeof backupArchiveSchema>;

/**
 * What a restore did.
 *
 * Reported rather than answered with a bare `ok`, because a restore is the one
 * operation whose result an operator cannot check by looking at the page: what
 * came back, what was skipped, and how many rows landed is the only account of it
 * they will get.
 */
export const restoreResultSchema = z.object({
  ok: z.literal(true),
  /** How many tables were replaced. */
  tables: z.number().int().nonnegative(),
  /** How many rows were written across them. */
  rows: z.number().int().nonnegative(),
  /** Tables the archive did not mention, so nothing in them was touched. */
  untouched: z.array(z.string()),
  /** Tables the restore refused, and why. */
  skipped: z.array(z.object({ table: z.string(), reason: z.string() })),
});
export type RestoreResult = z.infer<typeof restoreResultSchema>;

export type SystemResources = z.infer<typeof systemResourcesSchema>;
export type SystemHealthTile = z.infer<typeof systemHealthTileSchema>;
export type EndpointStatus = z.infer<typeof endpointStatusSchema>;
export type SystemStatus = z.infer<typeof systemStatusSchema>;
export type CreditPool = z.infer<typeof creditPoolSchema>;
export type Theme = z.infer<typeof themeSchema>;
export type GlassDepth = z.infer<typeof glassDepthSchema>;
export type Customization = z.infer<typeof customizationSchema>;
export type GeneralSettings = z.infer<typeof generalSettingsSchema>;
export type AuthStatus = z.infer<typeof authStatusSchema>;
export type BackupManifest = z.infer<typeof backupManifestSchema>;
