import { http } from '../net.ts';
import {
  authStatusSchema,
  backupArchiveSchema,
  backupBodySchema,
  backupManifestSchema,
  customizationSchema,
  customizationUpdateSchema,
  generalSettingsSchema,
  generalSettingsUpdateSchema,
  loginBodySchema,
  okSchema,
  passwordChangeBodySchema,
  restoreBodySchema,
  restoreResultSchema,
  setupBodySchema,
} from '@contracts';

import { db } from '../db.ts';
import { hoursFromNow } from '../clock.ts';
import { buildBackupArchive, buildBackupManifest, buildRestoreResult } from '../fixtures/system.ts';
import { badRequest, bodyOf, respond, route } from './helpers.ts';

/** System section: Customization, Settings, Auth, Backup & Restore. */

function tableCounts(): Record<string, number> {
  return {
    providers: db.providers.length,
    provider_models: db.models.length,
    accounts: db.accounts.length,
    api_keys: db.apiKeys.length,
    aliases: db.aliases.length,
    combos: db.combos.length,
    mappings: db.mappings.length,
    filter_rules: db.filterRules.length,
    jobs: db.jobs.length,
    proxies: db.proxies.length,
    requests: db.requests.length,
    logs: db.logs.length,
    chat_sessions: db.chatSessions.length,
    assets: db.assets.length,
    generations: db.generations.length,
    benchmarks: db.benchmarks.length,
    verifications: db.verifications.length,
    vcc_cards: db.vccCards.length,
  };
}

export const systemHandlers = [
  http.get(route('customization'), () => respond(customizationSchema, db.customization)),

  http.patch(route('customization'), async ({ request }) => {
    const patch = customizationUpdateSchema.parse(await bodyOf(request));
    return respond(customizationSchema, db.updateCustomization(patch));
  }),

  http.get(route('generalSettings'), () => respond(generalSettingsSchema, db.generalSettings)),

  http.patch(route('generalSettings'), async ({ request }) => {
    const patch = generalSettingsUpdateSchema.parse(await bodyOf(request));
    return respond(generalSettingsSchema, db.updateGeneralSettings(patch));
  }),

  http.get(route('authStatus'), () => respond(authStatusSchema, db.authStatus)),

  http.post(route('authSetup'), async ({ request }) => {
    const body = setupBodySchema.parse(await bodyOf(request));
    db.updateGeneralSettings({ instanceName: body.instanceName });
    db.authStatus.configured = true;
    db.authStatus.authenticated = true;
    db.authStatus.sessionExpiresAt = hoursFromNow(12);
    return respond(authStatusSchema, db.authStatus);
  }),

  http.post(route('authLogin'), async ({ request }) => {
    loginBodySchema.parse(await bodyOf(request));
    db.authStatus.authenticated = true;
    db.authStatus.sessionExpiresAt = hoursFromNow(12);
    return respond(authStatusSchema, db.authStatus);
  }),

  http.post(route('authLogout'), () => {
    db.authStatus.authenticated = false;
    db.authStatus.sessionExpiresAt = null;
    return respond(okSchema, { ok: true });
  }),

  http.post(route('authPassword'), async ({ request }) => {
    passwordChangeBodySchema.parse(await bodyOf(request));
    return respond(okSchema, { ok: true });
  }),

  http.get(route('backupManifest'), () =>
    respond(backupManifestSchema, buildBackupManifest(tableCounts())),
  ),

  /**
   * The archive itself, not a receipt for one.
   *
   * `respond` cannot be used here for the same reason the real route does not
   * answer with a JSON content type of its own: the body is an archive the
   * console hands straight to a download, and the point of the mock is that a
   * client reading it behaves exactly as it would against Hono.
   */
  http.post(route('backup'), async ({ request }) => {
    const body = backupBodySchema.parse(await bodyOf(request));
    const parsed = backupArchiveSchema.safeParse(
      buildBackupArchive(tableCounts(), body.includeCredentials),
    );
    if (!parsed.success) {
      return badRequest(
        `the mock produced an archive its own contract rejects: ${parsed.error.message}`,
      );
    }
    return new Response(JSON.stringify(parsed.data, null, 2), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }),

  http.post(route('restore'), async ({ request }) => {
    const body = restoreBodySchema.parse(await bodyOf(request));
    // The body is base64 of the archive, which is what the real route decodes.
    // Decoding it here is what makes the mock prove the console encoded it
    // correctly rather than merely sending something non-empty.
    const decoded = atob(body.archive);
    let archive: unknown;
    try {
      archive = JSON.parse(decoded);
    } catch {
      return badRequest('The archive is not a rutekit backup.');
    }
    const parsed = backupArchiveSchema.safeParse(archive);
    if (!parsed.success) return badRequest('The archive is not a rutekit backup.');
    return respond(restoreResultSchema, buildRestoreResult(parsed.data));
  }),
];
