import { Hono } from 'hono';
import {
  consolePaths,
  tokenSaverConfigUpdateSchema,
  tokenSaverSavingsQuerySchema,
} from '@contracts';

import { AppError } from '@server/errors.ts';
import { jsonBody } from '@server/ingress/validate.ts';
import { createSavingsService } from '@server/telemetry/savings.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The Token Saver's console (C14, FR-1.2 / A3).
 *
 * Three routes, and they are the last piece of the Routing section to land. The
 * compression pipeline has run since C4, `packages/compression` has reported a
 * `StageReport` per stage since it was written, and the console has had a page
 * for all of it since PHASE B — but nothing ever served that page. It was found by
 * `apps/server/test/contract.test.ts` in D1, which is what that test is for: the
 * server registered 81 of the contract's 85 paths, and the two missing were this.
 *
 * **Its own module rather than part of `routing.ts` or `tools.ts`.** It is neither
 * — the first is the three records that decide what a model name means, and the
 * second owns the filters, which are a different pipeline phase. The Token Saver
 * is a settings record plus a read model over telemetry, so it gets a file, the
 * same way `system.ts` and `verification.ts` do.
 *
 * The ordering note the other modules carry does not apply here in the same way,
 * but the rule does: `/token-saver/savings` is registered **before**
 * `/token-saver` is not required (they are different paths, and neither has a
 * parameter), so the two can sit in either order. They are written savings-first
 * so a reader meets the read-only route before the one that writes.
 */
export function tokenSaverRoutes(deps: AppDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const savings = createSavingsService({ requests: deps.requests });

  /**
   * What the Token Saver removed over a window.
   *
   * A query parsed rather than trusted, like every other windowed read: an
   * unknown window name is a 400 rather than a silent fallback to a default the
   * operator did not ask for.
   */
  router.get(consolePaths.tokenSaverSavings, (c) => {
    const parsed = tokenSaverSavingsQuerySchema.safeParse({
      window: c.req.query('window') ?? undefined,
    });
    if (!parsed.success) {
      throw AppError.invalidRequest(`Unknown window "${c.req.query('window') ?? ''}".`);
    }
    return c.json(savings.savings(parsed.data.window));
  });

  router.get(consolePaths.tokenSaver, (c) => c.json(deps.tokenSaver.read()));

  /**
   * A patch over the record, merged rather than replaced.
   *
   * The console's own schema makes every field optional, so a page that moved one
   * switch sends one field — and a write that replaced the record would reset
   * every stage the operator did not touch. `read()` is fail-open, so a stored row
   * that no longer fits the contract is the defaults rather than a 500, and the
   * merge starts from what the operator is actually looking at.
   */
  router.patch(consolePaths.tokenSaver, jsonBody(tokenSaverConfigUpdateSchema), (c) =>
    c.json(deps.tokenSaver.write(c.req.valid('json'))),
  );

  return router;
}
