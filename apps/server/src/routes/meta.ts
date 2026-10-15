import { Hono } from 'hono';
import type { ConsoleMeta } from '@contracts';
import { consolePaths } from '@contracts';

import { META_KEYS } from '@server/persistence/app-meta.ts';
import { currentSchemaVersion } from '@server/persistence/migrate.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';
import { SERVER_VERSION } from '@server/version.ts';

/**
 * What the server says about itself.
 *
 * The one control-plane route C1 serves, and it is not a placeholder: it reads
 * the boot timestamp and the schema version back out of SQLite, so a 200 here
 * proves the whole path — config, migration, write at boot, read at request
 * time, the console namespace, and the proxy in front of it.
 */
export function metaRoutes(deps: AppDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get(consolePaths.meta, (c) => {
    const payload: ConsoleMeta = {
      name: 'rutekit',
      version: SERVER_VERSION,
      schemaVersion: currentSchemaVersion(deps.persistence.sqlite),
      // The stored value is the authority; the in-process clock is only a
      // fallback for the first boot before the write lands.
      bootedAt:
        deps.meta.get(META_KEYS.bootStartedAt) ?? new Date(deps.lifecycle.startedAtMs).toISOString(),
      uptimeSeconds: deps.lifecycle.uptimeSeconds,
      database: { driver: 'sqlite', inMemory: deps.persistence.isMemory },
    };
    return c.json(payload);
  });

  return router;
}
