import type {
  BackupBody,
  CustomizationUpdate,
  GeneralSettingsUpdate,
  LoginBody,
  PasswordChangeBody,
  RestoreBody,
  SetupBody,
} from '@contracts';
import {
  authStatusSchema,
  backupArchiveSchema,
  backupManifestSchema,
  consolePath,
  consolePaths,
  customizationSchema,
  generalSettingsSchema,
  okSchema,
  restoreResultSchema,
} from '@contracts';

import { apiGet, apiPatch, apiPost } from './client.ts';

/**
 * The System section's requests, as plain functions.
 *
 * These are the endpoints that describe the instance rather than the traffic
 * through it: how it looks, how it behaves, who may open it, and what it would
 * take to move it somewhere else. They sit in one module because they are one
 * record in the end — a backup is the other three, serialised.
 */

/* ---- Appearance ---- */

export function fetchCustomization(signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.customization), customizationSchema, signal);
}

export function updateCustomization(patch: CustomizationUpdate, signal?: AbortSignal) {
  return apiPatch(consolePath(consolePaths.customization), customizationSchema, patch, signal);
}

/* ---- General ---- */

export function fetchGeneralSettings(signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.generalSettings), generalSettingsSchema, signal);
}

export function updateGeneralSettings(patch: GeneralSettingsUpdate, signal?: AbortSignal) {
  return apiPatch(consolePath(consolePaths.generalSettings), generalSettingsSchema, patch, signal);
}

/* ---- Auth ---- */

export function fetchAuthStatus(signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.authStatus), authStatusSchema, signal);
}

/**
 * Complete the first-run wizard.
 *
 * Both of the wizard's answers go in one request because they are one decision:
 * the instance does not exist until it has a name and a way in, and a half-done
 * first run would leave it either unnamed or open.
 */
export function setupInstance(body: SetupBody, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.authSetup), authStatusSchema, body, signal);
}

/** Open a session. Both this and `setupInstance` answer with the new auth record. */
export function login(body: LoginBody, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.authLogin), authStatusSchema, body, signal);
}

export function changePassword(body: PasswordChangeBody, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.authPassword), okSchema, body, signal);
}

export function logout(signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.authLogout), okSchema, undefined, signal);
}

/* ---- Backup & restore ---- */

export function fetchBackupManifest(signal?: AbortSignal) {
  return apiGet(consolePath(consolePaths.backupManifest), backupManifestSchema, signal);
}

/**
 * Start an export.
 *
 * The response *is* the archive, and the page hands it to the browser to save.
 * Nothing is written to the server's disk: the operator asked for a copy of their
 * instance, and the copy is theirs — a file rutekit kept would be one more thing
 * to leak, on the machine the archive is meant to survive.
 *
 * `includeCredentials` is the operator's explicit choice and defaults to false,
 * because an export that quietly carried every provider key would be the single
 * most damaging file to leak (SEC-6).
 */
export function startBackup(body: BackupBody, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.backup), backupArchiveSchema, body, signal);
}

/** Put an archive back. Replaces the tables it names, in one transaction. */
export function restoreBackup(body: RestoreBody, signal?: AbortSignal) {
  return apiPost(consolePath(consolePaths.restore), restoreResultSchema, body, signal);
}
