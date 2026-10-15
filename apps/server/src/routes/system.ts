import { Hono } from 'hono';
import type { RestoreResult } from '@contracts';
import {
  backupBodySchema,
  consolePaths,
  customizationUpdateSchema,
  generalSettingsUpdateSchema,
  restoreBodySchema,
} from '@contracts';

import { jsonBody } from '@server/ingress/validate.ts';
import { createCustomizationStore } from '@server/runtime/customization.ts';
import { createBackupService } from '@server/system/backup.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The System section's settings and backup (C13b).
 *
 * Six routes, and the two groups behave differently on purpose.
 *
 * **Customization and general settings are PATCHes over a single record.** The
 * console's own schemas make every field optional, so a page that changed one
 * switch sends one field and the store merges it — which is what stops a form
 * that forgot a field from resetting it. Both records live in `app_meta` and both
 * read fail-open, so an unreadable row is the defaults rather than a 500.
 *
 * **Backup is a dump and restore is a replace.** `POST /backup` answers with the
 * archive itself, which the browser downloads; `POST /restore` takes that same
 * archive back, base64-encoded, and replaces the tables it names in one
 * transaction. The archive is symmetric on purpose — what comes out is what goes
 * back in — and the operator keeps the file, which is the whole point of an
 * export.
 *
 * `GET /backup/manifest` stays because it is what the page reads to show what a
 * backup *would* contain without producing one: the counts, and the fact that
 * credentials are excluded by default.
 *
 * The auth routes are not here — they live in `routes/auth.ts` and are the
 * session guard's own business.
 */
export function systemRoutes(deps: AppDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const customization = createCustomizationStore({ meta: deps.meta });
  const backup = createBackupService({ persistence: deps.persistence, logger: deps.logger });

  /* ---- Appearance ---- */

  router.get(consolePaths.customization, (c) => c.json(customization.read()));

  router.patch(consolePaths.customization, jsonBody(customizationUpdateSchema), (c) =>
    c.json(customization.write(c.req.valid('json'))),
  );

  /* ---- General settings ---- */

  router.get(consolePaths.generalSettings, (c) => c.json(deps.settings.read()));

  router.patch(consolePaths.generalSettings, jsonBody(generalSettingsUpdateSchema), (c) =>
    c.json(deps.settings.write(c.req.valid('json'))),
  );

  /* ---- Backup & restore ---- */

  router.get(consolePaths.backupManifest, (c) => c.json(backup.manifest()));

  /**
   * The archive, ready to be written to a file.
   *
   * `content-disposition` as well as a JSON body, so a client that navigates to
   * this path gets a download with a sensible name rather than a page of JSON —
   * and so does a client that reads the body and saves it itself.
   */
  router.post(consolePaths.backup, jsonBody(backupBodySchema), (c) => {
    const archive = backup.export(c.req.valid('json'));
    const stamp = archive.createdAt.slice(0, 10);
    return c.body(JSON.stringify(archive, null, 2), 200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="rutekit-backup-${stamp}.json"`,
    });
  });

  router.post(consolePaths.restore, jsonBody(restoreBodySchema), (c) =>
    c.json(backup.restore(c.req.valid('json')) satisfies RestoreResult),
  );

  return router;
}
