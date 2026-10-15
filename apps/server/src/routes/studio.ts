import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Ok, StudioAssetsQuery, StudioGenerationsQuery } from '@contracts';
import {
  consolePaths,
  studioAssetUpdateSchema,
  studioAssetsQuerySchema,
  studioGenerateBodySchema,
  studioGenerationsQuerySchema,
} from '@contracts';

import { AppError } from '@server/errors.ts';
import { jsonBody } from '@server/ingress/validate.ts';
import type { AppDeps, AppEnv } from '@server/types.ts';

/**
 * The Studio console (C10, FR-8.1–8.6).
 *
 * Nine routes over two things: the files that came out of renders, and the
 * renders themselves. The interesting one is the file route, which is the only
 * place in the console that answers with bytes rather than a document — and the
 * one whose safety is not obvious from the handler, because the path it serves
 * from is built inside `storage.ts` out of an id rutekit minted and an extension
 * it allowlists. Nothing a provider said reaches a path.
 *
 * `POST /studio/generations` fans a `count` out into that many jobs and answers
 * `201` with all of them, because the console's composer asks for a batch in one
 * gesture and wants one list back to put in the queue. Nothing has rendered when
 * this returns: the reply is the queue's contents, not the result.
 *
 * The cancel route exists beside the `studio_cancel` websocket frame rather than
 * instead of it. The frame is what the contract declares and a client holding a
 * socket should use; this route is what the page actually can use, because the
 * Studio polls. Both end in the same call.
 */
export function studioRoutes(deps: AppDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const { studioCatalog: catalog, studioQueue: queue } = deps;

  /* ---- assets ---- */

  router.get(consolePaths.studioAssets, (c) => c.json(catalog.listAssets(assetsQueryOf(c))));

  // Before `/studio/assets/:id`: four segments to its three, so the literal
  // cannot be read as an asset id. Registered first anyway, matching the Tools
  // section's own ordering rule.
  router.get(consolePaths.studioAssetFile, async (c) => {
    const file = await catalog.file(c.req.param('id'));
    // A `Response` rather than `c.body`, because Hono's body helper types its
    // input as a `Uint8Array` over an `ArrayBuffer` specifically — and a buffer
    // read off disk is typed as the wider `ArrayBufferLike`. Narrowing it would
    // be a cast asserting something the runtime already guarantees, which is
    // exactly the shape of cast R1.3 exists to keep out.
    return new Response(file.bytes, {
      status: 200,
      headers: {
        'content-type': file.mimeType,
        // The bytes are addressed by an id that never changes, so a browser may
        // keep them. `private` because this is one operator's own render and a
        // shared cache has no business holding it.
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  });

  router.get(consolePaths.studioAsset, (c) => c.json(catalog.getAsset(c.req.param('id'))));

  router.patch(consolePaths.studioAsset, jsonBody(studioAssetUpdateSchema), (c) =>
    c.json(catalog.setFavorite(c.req.param('id'), c.req.valid('json').favorite)),
  );

  router.delete(consolePaths.studioAsset, async (c) => {
    await catalog.removeAsset(c.req.param('id'));
    return c.json({ ok: true } satisfies Ok);
  });

  /* ---- generations ---- */

  router.get(consolePaths.studioGenerations, (c) =>
    c.json(catalog.listGenerations(generationsQueryOf(c))),
  );

  router.post(consolePaths.studioGenerations, jsonBody(studioGenerateBodySchema), (c) =>
    c.json({ jobs: queue.submit(c.req.valid('json')) }, 201),
  );

  // Before `/studio/generations/:id`, for the same reason as the file route.
  router.post(consolePaths.studioGenerationCancel, (c) => c.json(queue.cancel(c.req.param('id'))));

  router.get(consolePaths.studioGeneration, (c) =>
    c.json(catalog.getGeneration(c.req.param('id'))),
  );

  return router;
}

/** The gallery's query, read off the URL. */
function assetsQueryOf(c: Context<AppEnv>): StudioAssetsQuery {
  const parsed = studioAssetsQuerySchema.safeParse({
    q: c.req.query('q') ?? '',
    sort: c.req.query('sort') ?? null,
    direction: c.req.query('direction') ?? undefined,
    limit: c.req.query('limit') ?? undefined,
    cursor: c.req.query('cursor') ?? null,
    kind: c.req.query('kind') ?? null,
    // A query string has no booleans, so the only truthy spelling is the word.
    // Anything else — absent, `false`, a typo — means "do not filter", which is
    // the reading that shows an operator their whole gallery rather than none of
    // it.
    favorite: c.req.query('favorite') === 'true',
  });
  if (!parsed.success) throw AppError.invalidRequest('The asset query was not valid.');
  return parsed.data;
}

/** The queue's query, read off the URL. */
function generationsQueryOf(c: Context<AppEnv>): StudioGenerationsQuery {
  const parsed = studioGenerationsQuerySchema.safeParse({
    sort: c.req.query('sort') ?? null,
    direction: c.req.query('direction') ?? undefined,
    limit: c.req.query('limit') ?? undefined,
    cursor: c.req.query('cursor') ?? null,
    kind: c.req.query('kind') ?? null,
    status: c.req.query('status') ?? null,
  });
  if (!parsed.success) throw AppError.invalidRequest('The generation query was not valid.');
  return parsed.data;
}
