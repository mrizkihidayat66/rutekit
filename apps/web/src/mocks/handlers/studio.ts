import type { Asset, GenerationJob } from '@contracts';
import {
  assetSchema,
  consolePath,
  consolePaths,
  generationJobSchema,
  studioAssetUpdateSchema,
  studioAssetsResponseSchema,
  studioGenerateBodySchema,
  studioGenerateResultSchema,
  studioGenerationsResponseSchema,
} from '@contracts';

import { isoAt } from '../clock.ts';
import { db, matches, paginate, sortBy } from '../db.ts';
import { swatch } from '../fixtures/tools.ts';
import { http } from '../net.ts';
import {
  bodyOf,
  boolParam,
  fileResponse,
  listParams,
  notFound,
  ok,
  paramId,
  respond,
  route,
  searchParams,
  strParam,
  uid,
} from './helpers.ts';

/**
 * The Studio page, mocked (FR-8.x).
 *
 * Its own domain rather than part of `tools`, for the same reason `chat` is: the
 * Tools section's pages have separate backends that land in separate groups, and
 * a domain is what goes live at once. Studio's landed in C10 while Benchmark and
 * Verification are still to come (C11–C12), so keeping it inside `tools` would
 * mean flipping three pages to see one of them work.
 *
 * The queue is the interesting part. A queue is the one thing in the console that
 * is interesting *because* it changes, so the mock derives progress from the
 * clock on every read rather than driving it from a timer: a timer would keep
 * ticking in a background tab and would have to be torn down, while elapsed time
 * costs nothing and is correct whenever it is asked.
 */

/* ---- Studio: the generation queue ---- */

/** A job in one of these states is still going to change on its own. */
const LIVE_GENERATION_STATUSES: readonly GenerationJob['status'][] = [
  'queued',
  'executing',
  'progress',
];

/** How long a mocked generation takes, and how far apart the live ones start. */
const GENERATION_MS = 16_000;
const GENERATION_STAGGER_MS = 2_600;

/** When each live job started, and how long it takes. Filled on first read. */
const generationPlans = new Map<string, { readonly startMs: number; readonly durationMs: number }>();

/**
 * Which asset each job was seeded from (FR-8.4).
 *
 * A side table rather than a field on the job, because the contract puts the
 * lineage on the *asset*: a request is not a descendant of anything, the picture
 * it produces is. The real backend keeps the same link in a column.
 */
const generationParents = new Map<string, string>();

let generatedAssetCount = 0;

/**
 * Move the live generations along with the clock.
 *
 * A queue is the one part of the console that is interesting *because* it
 * changes, so a mock that froze it at `progress: 0.62` would make the page's
 * polling invisible and the progress bar a decoration. Progress is therefore
 * derived from wall-clock time on each read rather than driven by a timer: a
 * timer would keep ticking in a background tab and would have to be torn down,
 * while elapsed time costs nothing and is correct whenever it is asked.
 *
 * The live jobs are re-anchored the first time this runs. Their fixture
 * timestamps are hours old — deliberately, so the history looks lived-in — and
 * a job stamped four hours ago would otherwise be finished before anyone
 * looked at it. Jobs the operator queues are picked up on the read after they
 * are created, so they animate too.
 */
function advanceGenerations(): void {
  const now = Date.now();
  if (generationPlans.size === 0) staggerExistingGenerations();

  for (const job of db.generations) {
    if (!LIVE_GENERATION_STATUSES.includes(job.status)) continue;

    let plan = generationPlans.get(job.id);
    if (plan === undefined) {
      plan = { startMs: now, durationMs: GENERATION_MS };
      generationPlans.set(job.id, plan);
    }

    const ratio = (now - plan.startMs) / plan.durationMs;
    if (ratio < 0) {
      job.status = 'queued';
      job.progress = null;
      job.stage = 'Waiting for a worker';
      continue;
    }
    if (ratio >= 1) {
      finishGeneration(job);
      continue;
    }

    job.status = ratio < 0.12 ? 'executing' : 'progress';
    job.stage = ratio < 0.12 ? 'Loading model' : 'Sampling';
    job.progress = Math.round(Math.min(0.99, Math.max(0.02, ratio)) * 100) / 100;
    job.startedAt ??= new Date(plan.startMs).toISOString();
  }
}

/** Land a finished job as an asset, so the gallery fills in behind the queue. */
function finishGeneration(job: GenerationJob): void {
  generatedAssetCount += 1;
  const assetId = `asset_new_${String(generatedAssetCount).padStart(3, '0')}`;
  const isVideo = job.kind === 'video';

  const asset: Asset = {
    id: assetId,
    kind: job.kind,
    url: consolePath(consolePaths.studioAssetFile, { id: assetId }),
    thumbnailUrl: swatch((generatedAssetCount * 61) % 360, isVideo ? 'video' : 'image'),
    width: isVideo ? 1280 : 1024,
    height: isVideo ? 720 : 1024,
    durationSeconds: isVideo ? 5.4 : null,
    mimeType: isVideo ? 'video/mp4' : 'image/png',
    byteSize: isVideo ? 8_400_000 : 1_240_000,
    providerId: job.providerId,
    model: job.model,
    prompt: job.prompt,
    negativePrompt: job.negativePrompt,
    parameters: job.parameters,
    parentAssetId: generationParents.get(job.id) ?? null,
    favorite: false,
    createdAt: new Date().toISOString(),
  };
  db.assets.unshift(asset);

  job.status = 'executed';
  job.progress = 1;
  job.stage = 'Complete';
  job.assetId = assetId;
  job.finishedAt = new Date().toISOString();
}

/** Space the jobs that were already in flight apart, so they do not land together. */
function staggerExistingGenerations(): void {
  const now = Date.now();
  let index = 0;
  for (const job of db.generations) {
    if (!LIVE_GENERATION_STATUSES.includes(job.status)) continue;
    generationPlans.set(job.id, {
      startMs: now + index * GENERATION_STAGGER_MS,
      durationMs: GENERATION_MS + index * 4_000,
    });
    index += 1;
  }
}

export const studioHandlers = [
  http.get(route('studioAssets'), ({ request }) => {
    advanceGenerations();
    const params = searchParams(request);
    const { cursor, limit, sort, direction } = listParams(request);
    const kind = strParam(params, 'kind');
    const favorite = boolParam(params, 'favorite');
    const q = params.get('q') ?? '';

    let items = db.assets;
    if (kind !== null) items = items.filter((entry) => entry.kind === kind);
    if (favorite) items = items.filter((entry) => entry.favorite);
    items = items.filter((entry) => matches([entry.prompt, entry.model, entry.providerId, entry.id], q));

    return respond(studioAssetsResponseSchema, paginate(sortBy(items, sort, direction), { cursor, limit }));
  }),

  http.get(route('studioAsset'), ({ params }) => {
    const asset = db.asset(paramId(params));
    return asset === undefined ? notFound('asset', paramId(params)) : respond(assetSchema, asset);
  }),

  /**
   * The asset's bytes.
   *
   * The gallery grid draws `thumbnailUrl`, but the detail view loads the real
   * `url` — so the mock has to answer it, or every full-size preview would be a
   * broken image. Video assets are answered the same way: a hand-authored SVG
   * stands in for the frame, and the page's player falls back to that still when
   * the media cannot be decoded, which is the state a real backend can produce
   * too (a render that expired, a codec the browser lacks).
   */
  http.get(route('studioAssetFile'), ({ params }) => {
    const asset = db.asset(paramId(params));
    if (asset === undefined) return notFound('asset', paramId(params));
    return fileResponse(asset.thumbnailUrl ?? '', 'image/svg+xml');
  }),

  http.patch(route('studioAsset'), async ({ params, request }) => {
    const asset = db.asset(paramId(params));
    if (asset === undefined) return notFound('asset', paramId(params));
    const patch = studioAssetUpdateSchema.parse(await bodyOf(request));
    asset.favorite = patch.favorite;
    return respond(assetSchema, asset);
  }),

  http.delete(route('studioAsset'), ({ params }) => {
    const index = db.assets.findIndex((entry) => entry.id === paramId(params));
    if (index === -1) return notFound('asset', paramId(params));
    db.assets.splice(index, 1);
    return ok();
  }),

  http.get(route('studioGenerations'), ({ request }) => {
    advanceGenerations();
    const params = searchParams(request);
    const { cursor, limit, sort, direction } = listParams(request);
    const kind = strParam(params, 'kind');
    const status = strParam(params, 'status');

    let items = db.generations;
    if (kind !== null) items = items.filter((entry) => entry.kind === kind);
    if (status !== null) items = items.filter((entry) => entry.status === status);

    return respond(studioGenerationsResponseSchema, paginate(sortBy(items, sort, direction), { cursor, limit }));
  }),

  http.post(route('studioGenerations'), async ({ request }) => {
    const input = studioGenerateBodySchema.parse(await bodyOf(request));
    const jobs: GenerationJob[] = [];
    for (let index = 0; index < input.count; index += 1) {
      const job: GenerationJob = {
        id: uid('gen'),
        kind: input.kind,
        status: 'queued',
        providerId: input.providerId,
        model: input.model,
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        progress: null,
        stage: 'Waiting for a worker',
        assetId: null,
        error: null,
        parameters: input.parameters,
        createdAt: isoAt(0),
        startedAt: null,
        finishedAt: null,
      };
      db.generations.unshift(job);
      // The lineage the job carries is not on the job: `generationJobSchema` has
      // no parent field, because a request is not a descendant of anything — the
      // *asset* it produces is. So the mock keeps the link on the side, the way a
      // real backend keeps it in a column the read model does not expose.
      if (input.parentAssetId !== null) generationParents.set(job.id, input.parentAssetId);
      jobs.push(job);
    }
    return respond(studioGenerateResultSchema, { jobs });
  }),

  http.get(route('studioGeneration'), ({ params }) => {
    advanceGenerations();
    const generation = db.generation(paramId(params));
    return generation === undefined ? notFound('generation', paramId(params)) : respond(generationJobSchema, generation);
  }),

  /**
   * Stop a render.
   *
   * A queued job is cancelled outright; one already sampling is cancelled too,
   * because the mock's progress is derived from the clock rather than driven by
   * a timer — there is no work to stop, so the status is the whole of it.
   * `advanceGenerations` only ever moves jobs that are still live, so a
   * cancelled row stays cancelled on the next read.
   */
  http.post(route('studioGenerationCancel'), ({ params }) => {
    const generation = db.generation(paramId(params));
    if (generation === undefined) return notFound('generation', paramId(params));
    if (LIVE_GENERATION_STATUSES.includes(generation.status)) {
      generation.status = 'cancelled';
      generation.stage = 'Cancelled';
      generation.progress = null;
      generation.finishedAt = isoAt(0);
    }
    return respond(generationJobSchema, generation);
  }),
];
