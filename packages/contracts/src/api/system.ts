import { z } from 'zod';
import { isoDateTimeSchema } from '../common.ts';
import { customizationSchema, generalSettingsSchema } from '../entities/system.ts';
import { updateSchema } from './shared.ts';

/** System section: Customization, Settings, Auth, Backup & Restore. */

/* ---- Instance meta ---- */

/**
 * What the server says about itself. Read from the instance's own store rather
 * than hard-coded, so a client can tell which build is answering and whether the
 * schema it is talking to is the one it expects.
 */
export const consoleMetaSchema = z.object({
  name: z.literal('rutekit'),
  version: z.string(),
  /** Highest applied migration id; 0 before the first migration runs. */
  schemaVersion: z.number().int().nonnegative(),
  bootedAt: isoDateTimeSchema,
  uptimeSeconds: z.number().int().nonnegative(),
  database: z.object({
    driver: z.literal('sqlite'),
    /** True when the instance is running against an ephemeral database. */
    inMemory: z.boolean(),
  }),
});
export type ConsoleMeta = z.infer<typeof consoleMetaSchema>;

/* ---- Customization (B6) ---- */

export const customizationUpdateSchema = updateSchema(customizationSchema.shape);
export type CustomizationUpdate = z.infer<typeof customizationUpdateSchema>;

/* ---- General Settings (B6) ---- */

export const generalSettingsUpdateSchema = updateSchema(generalSettingsSchema.shape);
export type GeneralSettingsUpdate = z.infer<typeof generalSettingsUpdateSchema>;

/* ---- Auth (single-user, D8) ---- */

/** First-run wizard: sets the password and names the instance in one step. */
export const setupBodySchema = z.object({
  password: z.string().min(8),
  instanceName: z.string().min(1).max(64),
});
export type SetupBody = z.infer<typeof setupBodySchema>;

export const loginBodySchema = z.object({ password: z.string().min(1) });
export type LoginBody = z.infer<typeof loginBodySchema>;

export const passwordChangeBodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});
export type PasswordChangeBody = z.infer<typeof passwordChangeBodySchema>;

/* ---- Backup & Restore (B6) ---- */

/**
 * `includeCredentials` defaults to false on purpose: an export that quietly
 * carried every provider key and account token would be the single most
 * damaging file to leak, so the operator has to ask for it (SEC-6).
 */
export const backupBodySchema = z.object({
  includeCredentials: z.boolean().default(false),
});
export type BackupBody = z.infer<typeof backupBodySchema>;

export const restoreBodySchema = z.object({
  /**
   * The archive, base64-encoded.
   *
   * Base64 rather than the JSON text itself: the archive is a document that
   * already carries its own quoting and newlines, and putting it in a JSON string
   * field unencoded means every reader has to be sure it round-trips exactly. The
   * cost is a third more bytes on the wire, which is the price of a body that
   * cannot be subtly wrong.
   */
  archive: z.string().min(1),
  /** Guard against a mis-click wiping the live instance. */
  confirm: z.literal(true),
});
export type RestoreBody = z.infer<typeof restoreBodySchema>;
