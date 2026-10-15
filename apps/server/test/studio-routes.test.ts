import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_API_PREFIX,
  assetSchema,
  consoleErrorSchema,
  consolePaths,
  generationJobSchema,
  studioAssetsResponseSchema,
  studioGenerateResultSchema,
  studioGenerationsResponseSchema,
} from '@contracts';
import type { GenerationJob } from '@contracts';

import { buildApp } from '@server/app.ts';
import { createMediaDrivers } from '@server/studio/driver.ts';
import { fakeMediaDriver, PNG_BYTES, type FakeMediaDriver } from './fake-media.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The Studio console, end to end (C10, FR-8.1–8.6).
 *
 * A real composition with only the media driver replaced: the session guard, the
 * studio routes, the queue, the asset storage, and the SQLite rows behind all of
 * it. What these assert is what an operator can actually observe — a batch of
 * jobs appearing, a file landing behind one of them, the gallery serving it back,
 * and a render being stopped.
 *
 * The two worth reading are the file route and the cancel. The first is the only
 * place in the console that answers with bytes, and the second is the only one
 * where a job's outcome depends on *why* it stopped.
 */

const PASSWORD = 'correct-horse-battery';

type App = ReturnType<typeof buildApp>;

const servers: TestServer[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
});

async function signIn(app: App): Promise<string> {
  const response = await app.request(`${CONSOLE_API_PREFIX}${consolePaths.authSetup}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, instanceName: 'Test' }),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) throw new Error('setup did not set a session cookie');
  const pair = setCookie.split(';')[0];
  if (pair === undefined) throw new Error('empty set-cookie header');
  return pair;
}

async function call(
  app: App,
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  return app.request(path, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

interface Harness {
  readonly server: TestServer;
  readonly app: App;
  readonly cookie: string;
  readonly driver: FakeMediaDriver;
}

async function harness(
  options: {
    readonly driver?: FakeMediaDriver;
    readonly noDriver?: boolean;
    /** One by default, so a batch of two leaves the second job visibly queued. */
    readonly concurrency?: number;
  } = {},
): Promise<Harness> {
  const driver = options.driver ?? fakeMediaDriver();
  const server = makeServer({
    mediaDrivers: createMediaDrivers({
      drivers: options.noDriver === true ? [] : [driver],
    }),
    studioConcurrency: options.concurrency ?? 1,
  });
  server.lifecycle.markReady();
  servers.push(server);

  const app = buildApp(server);
  return { server, app, cookie: await signIn(app), driver };
}

const ASSETS = `${CONSOLE_API_PREFIX}${consolePaths.studioAssets}`;
const GENERATIONS = `${CONSOLE_API_PREFIX}${consolePaths.studioGenerations}`;
const assetPath = (id: string): string =>
  `${CONSOLE_API_PREFIX}${consolePaths.studioAsset.replace(':id', id)}`;
const assetFilePath = (id: string): string =>
  `${CONSOLE_API_PREFIX}${consolePaths.studioAssetFile.replace(':id', id)}`;
const generationPath = (id: string): string =>
  `${CONSOLE_API_PREFIX}${consolePaths.studioGeneration.replace(':id', id)}`;
const cancelPath = (id: string): string =>
  `${CONSOLE_API_PREFIX}${consolePaths.studioGenerationCancel.replace(':id', id)}`;

async function errorOf(response: Response): Promise<{ kind: string; message: string }> {
  return consoleErrorSchema.parse(await response.json()).error;
}

const BODY = {
  kind: 'image',
  providerId: 'comfyui-local',
  model: 'sd_xl_base_1.0.safetensors',
  prompt: 'a lighthouse at dusk',
  negativePrompt: null,
  parameters: { aspect: '1:1', steps: 20 },
  count: 1,
  parentAssetId: null,
} as const;

/** Poll a generation until it reaches a state it will not leave. */
async function settled(h: Harness, id: string, timeoutMs = 3_000): Promise<GenerationJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await call(h.app, generationPath(id), { cookie: h.cookie });
    const job = generationJobSchema.parse(await response.json());
    if (!['queued', 'executing', 'progress'].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`generation ${id} never settled: ${job.status}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/* ---- Submitting ---- */

describe('queueing a render', () => {
  it('answers 201 with the batch, and lands a file behind each job', async () => {
    const h = await harness();

    const response = await call(h.app, GENERATIONS, {
      method: 'POST',
      cookie: h.cookie,
      body: { ...BODY, count: 3 },
    });

    expect(response.status).toBe(201);
    const { jobs } = studioGenerateResultSchema.parse(await response.json());
    expect(jobs).toHaveLength(3);
    expect(jobs.every((job) => job.status === 'queued')).toBe(true);

    for (const job of jobs) {
      const done = await settled(h, job.id);
      expect(done.status).toBe('executed');
      expect(done.assetId).not.toBeNull();
    }

    const listed = studioAssetsResponseSchema.parse(
      await (await call(h.app, ASSETS, { cookie: h.cookie })).json(),
    );
    expect(listed.total).toBe(3);
  });

  it('passes the prompt, the model and the parameters to the driver', async () => {
    const h = await harness();
    const created = studioGenerateResultSchema.parse(
      await (
        await call(h.app, GENERATIONS, { method: 'POST', cookie: h.cookie, body: BODY })
      ).json(),
    );
    const job = created.jobs[0];
    if (job === undefined) throw new Error('no job');
    await settled(h, job.id);

    expect(h.driver.requests[0]).toMatchObject({
      kind: 'image',
      model: 'sd_xl_base_1.0.safetensors',
      prompt: 'a lighthouse at dusk',
      parameters: { aspect: '1:1', steps: 20 },
    });
  });

  it('records where a refined render came from', async () => {
    // `Asset.parentAssetId` has been in the contract since FASE B with nothing
    // to fill it; this is the half that makes the composer's lineage real rather
    // than a caption.
    const h = await harness();
    const created = studioGenerateResultSchema.parse(
      await (
        await call(h.app, GENERATIONS, {
          method: 'POST',
          cookie: h.cookie,
          body: { ...BODY, parentAssetId: 'asset_parent' },
        })
      ).json(),
    );
    const job = created.jobs[0];
    if (job === undefined) throw new Error('no job');
    const done = await settled(h, job.id);
    if (done.assetId === null) throw new Error('no asset');

    const asset = assetSchema.parse(
      await (await call(h.app, assetPath(done.assetId), { cookie: h.cookie })).json(),
    );
    expect(asset.parentAssetId).toBe('asset_parent');
  });

  it('refuses a provider rutekit does not have', async () => {
    const h = await harness();
    const response = await call(h.app, GENERATIONS, {
      method: 'POST',
      cookie: h.cookie,
      body: { ...BODY, providerId: 'no-such-provider' },
    });

    expect(response.status).toBe(404);
    expect((await errorOf(response)).message).toMatch(/No provider/);
  });

  it('fails the job when the provider has no media driver, naming what would work', async () => {
    // A provider rutekit cannot render with is not a 500 from a half-written
    // adapter: the queue records the refusal on the job, where an operator will
    // look for it.
    const h = await harness({ noDriver: true });
    const created = studioGenerateResultSchema.parse(
      await (
        await call(h.app, GENERATIONS, { method: 'POST', cookie: h.cookie, body: BODY })
      ).json(),
    );
    const job = created.jobs[0];
    if (job === undefined) throw new Error('no job');

    const done = await settled(h, job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/no media driver/);
  });

  it('fails a video render the driver refused, keeping its words', async () => {
    const h = await harness({
      driver: fakeMediaDriver({ refuseVideo: 'a text-to-video graph is a different workflow' }),
    });
    const created = studioGenerateResultSchema.parse(
      await (
        await call(h.app, GENERATIONS, {
          method: 'POST',
          cookie: h.cookie,
          body: { ...BODY, kind: 'video' },
        })
      ).json(),
    );
    const job = created.jobs[0];
    if (job === undefined) throw new Error('no job');

    const done = await settled(h, job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toContain('a text-to-video graph is a different workflow');
  });

  it('refuses an anonymous caller', async () => {
    const h = await harness();
    const response = await call(h.app, GENERATIONS, { method: 'POST', body: BODY });
    expect(response.status).toBe(401);
  });

  it('refuses a body the contract does not accept', async () => {
    const h = await harness();
    const response = await call(h.app, GENERATIONS, {
      method: 'POST',
      cookie: h.cookie,
      body: { ...BODY, prompt: '' },
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).kind).toBe('invalid_request');
  });
});

/* ---- The gallery ---- */

describe('the gallery', () => {
  it('serves the file back with the content type its extension implies', async () => {
    // The only route in the console that answers with bytes rather than a
    // document, and the one whose safety is not visible from the handler: the
    // path is built from an id rutekit minted and an extension it allowlists.
    const h = await harness();
    const created = studioGenerateResultSchema.parse(
      await (
        await call(h.app, GENERATIONS, { method: 'POST', cookie: h.cookie, body: BODY })
      ).json(),
    );
    const job = created.jobs[0];
    if (job === undefined) throw new Error('no job');
    const done = await settled(h, job.id);
    if (done.assetId === null) throw new Error('no asset');

    const response = await call(h.app, assetFilePath(done.assetId), { cookie: h.cookie });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it('answers 404 naming the file when the bytes are gone but the row is not', async () => {
    // A data directory that was cleaned, or a restore that brought the database
    // without the files. Saying which half is missing is the difference between
    // an operator who knows what happened and one who thinks rutekit lost it.
    const h = await harness();
    const created = studioGenerateResultSchema.parse(
      await (
        await call(h.app, GENERATIONS, { method: 'POST', cookie: h.cookie, body: BODY })
      ).json(),
    );
    const job = created.jobs[0];
    if (job === undefined) throw new Error('no job');
    const done = await settled(h, job.id);
    if (done.assetId === null) throw new Error('no asset');

    // The row stays; only the bytes go, which is exactly the state a cleaned
    // data directory leaves behind.
    rmSync(join(h.server.dataDir, 'studio', `${done.assetId}.png`));

    const response = await call(h.app, assetFilePath(done.assetId), { cookie: h.cookie });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).message).toMatch(/missing from the data directory/);

    // And the asset is still listed, so the operator can see it and delete it.
    expect((await call(h.app, assetPath(done.assetId), { cookie: h.cookie })).status).toBe(200);
  });

  it('carries a url the console can load, built from the id', async () => {
    const h = await harness();
    const created = studioGenerateResultSchema.parse(
      await (
        await call(h.app, GENERATIONS, { method: 'POST', cookie: h.cookie, body: BODY })
      ).json(),
    );
    const job = created.jobs[0];
    if (job === undefined) throw new Error('no job');
    await settled(h, job.id);

    const listed = studioAssetsResponseSchema.parse(
      await (await call(h.app, ASSETS, { cookie: h.cookie })).json(),
    );
    const asset = listed.items[0];
    if (asset === undefined) throw new Error('no asset');

    expect(asset.url).toBe(assetFilePath(asset.id));
    // The contract allows a thumbnail and the gallery falls back to the full
    // file. Returning the same URL here would tell the grid a preview exists and
    // hand it the full image, which is worse than saying there is none.
    expect(asset.thumbnailUrl).toBeNull();
  });

  it('stars an asset and filters the gallery by it', async () => {
    const h = await harness();
    const created = studioGenerateResultSchema.parse(
      await (
        await call(h.app, GENERATIONS, {
          method: 'POST',
          cookie: h.cookie,
          body: { ...BODY, count: 2 },
        })
      ).json(),
    );
    for (const job of created.jobs) await settled(h, job.id);

    const all = studioAssetsResponseSchema.parse(
      await (await call(h.app, ASSETS, { cookie: h.cookie })).json(),
    );
    const target = all.items[0];
    if (target === undefined) throw new Error('no asset');

    const starred = assetSchema.parse(
      await (
        await call(h.app, assetPath(target.id), {
          method: 'PATCH',
          cookie: h.cookie,
          body: { favorite: true },
        })
      ).json(),
    );
    expect(starred.favorite).toBe(true);

    const onlyStarred = studioAssetsResponseSchema.parse(
      await (await call(h.app, `${ASSETS}?favorite=true`, { cookie: h.cookie })).json(),
    );
    expect(onlyStarred.items.map((asset) => asset.id)).toEqual([target.id]);
  });

  it('filters the gallery by kind and by a search term', async () => {
    const h = await harness();
    const created = studioGenerateResultSchema.parse(
      await (
        await call(h.app, GENERATIONS, {
          method: 'POST',
          cookie: h.cookie,
          body: { ...BODY, prompt: 'a lonely lighthouse' },
        })
      ).json(),
    );
    const job = created.jobs[0];
    if (job === undefined) throw new Error('no job');
    await settled(h, job.id);

    const byText = studioAssetsResponseSchema.parse(
      await (await call(h.app, `${ASSETS}?q=lighthouse`, { cookie: h.cookie })).json(),
    );
    expect(byText.total).toBe(1);

    const byKind = studioAssetsResponseSchema.parse(
      await (await call(h.app, `${ASSETS}?kind=video`, { cookie: h.cookie })).json(),
    );
    expect(byKind.total).toBe(0);
  });

  it('deletes an asset and its file', async () => {
    const h = await harness();
    const created = studioGenerateResultSchema.parse(
      await (
        await call(h.app, GENERATIONS, { method: 'POST', cookie: h.cookie, body: BODY })
      ).json(),
    );
    const job = created.jobs[0];
    if (job === undefined) throw new Error('no job');
    const done = await settled(h, job.id);
    if (done.assetId === null) throw new Error('no asset');

    const deleted = await call(h.app, assetPath(done.assetId), {
      method: 'DELETE',
      cookie: h.cookie,
    });
    expect(deleted.status).toBe(200);

    expect((await call(h.app, assetPath(done.assetId), { cookie: h.cookie })).status).toBe(404);
    expect((await call(h.app, assetFilePath(done.assetId), { cookie: h.cookie })).status).toBe(404);
  });

  it('answers not_found for an asset that is not there', async () => {
    const h = await harness();
    const response = await call(h.app, assetPath('nope'), { cookie: h.cookie });
    expect(response.status).toBe(404);
  });
});

/* ---- Stopping a render ---- */

describe('cancelling a render', () => {
  it('stops a running job and reports it cancelled, not failed', async () => {
    // A cancel is not a failure: reporting it as one would send an operator
    // looking for a cause that does not exist. The queue's own flag is what
    // separates it from a timeout, which aborts the same controller.
    const h = await harness({ driver: fakeMediaDriver({ hang: true }) });
    const created = studioGenerateResultSchema.parse(
      await (
        await call(h.app, GENERATIONS, { method: 'POST', cookie: h.cookie, body: BODY })
      ).json(),
    );
    const job = created.jobs[0];
    if (job === undefined) throw new Error('no job');

    // Wait until it is actually running, or the cancel would take the queued path.
    const deadline = Date.now() + 2_000;
    for (;;) {
      const current = generationJobSchema.parse(
        await (await call(h.app, generationPath(job.id), { cookie: h.cookie })).json(),
      );
      if (current.status === 'progress') break;
      if (Date.now() > deadline) throw new Error('the render never started');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const response = await call(h.app, cancelPath(job.id), { method: 'POST', cookie: h.cookie });
    expect(response.status).toBe(200);

    const done = await settled(h, job.id);
    expect(done.status).toBe('cancelled');
    expect(done.error).toBeNull();
    expect(done.assetId).toBeNull();
  });

  it('cancels a job that has not started, so it never runs', async () => {
    // The cap is one and the first render hangs, so the second stays queued —
    // which is the case `takeNext` has to respect, or a cancelled row would
    // still be picked up and rendered.
    const h = await harness({ driver: fakeMediaDriver({ hang: true }) });
    const created = studioGenerateResultSchema.parse(
      await (
        await call(h.app, GENERATIONS, {
          method: 'POST',
          cookie: h.cookie,
          body: { ...BODY, count: 2 },
        })
      ).json(),
    );
    const [, second] = created.jobs;
    if (second === undefined) throw new Error('no second job');

    const response = await call(h.app, cancelPath(second.id), {
      method: 'POST',
      cookie: h.cookie,
    });
    expect(generationJobSchema.parse(await response.json()).status).toBe('cancelled');

    // Let the queue settle, then confirm the second job never reached the driver.
    await settled(h, created.jobs[0]?.id ?? '').catch(() => undefined);
    expect(h.driver.requests).toHaveLength(1);
  });

  it('leaves a finished job alone', async () => {
    const h = await harness();
    const created = studioGenerateResultSchema.parse(
      await (
        await call(h.app, GENERATIONS, { method: 'POST', cookie: h.cookie, body: BODY })
      ).json(),
    );
    const job = created.jobs[0];
    if (job === undefined) throw new Error('no job');
    const done = await settled(h, job.id);

    const response = await call(h.app, cancelPath(job.id), { method: 'POST', cookie: h.cookie });
    const after = generationJobSchema.parse(await response.json());
    expect(after.status).toBe('executed');
    expect(after.assetId).toBe(done.assetId);
  });

  it('answers not_found for a generation that is not there', async () => {
    const h = await harness();
    const response = await call(h.app, cancelPath('nope'), { method: 'POST', cookie: h.cookie });
    expect(response.status).toBe(404);
  });
});

/* ---- The queue listing ---- */

describe('the queue listing', () => {
  it('lists generations newest first and filters by status', async () => {
    const h = await harness();
    const created = studioGenerateResultSchema.parse(
      await (
        await call(h.app, GENERATIONS, { method: 'POST', cookie: h.cookie, body: BODY })
      ).json(),
    );
    const job = created.jobs[0];
    if (job === undefined) throw new Error('no job');
    await settled(h, job.id);

    const all = studioGenerationsResponseSchema.parse(
      await (await call(h.app, GENERATIONS, { cookie: h.cookie })).json(),
    );
    expect(all.total).toBe(1);

    const executed = studioGenerationsResponseSchema.parse(
      await (await call(h.app, `${GENERATIONS}?status=executed`, { cookie: h.cookie })).json(),
    );
    expect(executed.total).toBe(1);

    const queued = studioGenerationsResponseSchema.parse(
      await (await call(h.app, `${GENERATIONS}?status=queued`, { cookie: h.cookie })).json(),
    );
    expect(queued.total).toBe(0);
  });

  it('answers not_found for a generation that is not there', async () => {
    const h = await harness();
    const response = await call(h.app, generationPath('nope'), { cookie: h.cookie });
    expect(response.status).toBe(404);
  });
});
