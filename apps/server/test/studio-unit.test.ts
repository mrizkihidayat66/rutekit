import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GenerationJob, StudioGenerateBody } from '@contracts';
import { createProviderRegistry } from '@registry';
import { providerManifests } from '@registry/providers/index.ts';

import { silentLogger } from '@server/observability/logger.ts';
import { openPersistence } from '@server/persistence/client.ts';
import { runMigrations } from '@server/persistence/migrate.ts';
import { createStudioRepository } from '@server/persistence/studio.ts';
import {
  RenderCancelledError,
  createMediaDrivers,
  noMediaDriver,
  type MediaDriver,
  type MediaRequest,
} from '@server/studio/driver.ts';
import { buildGraph, createComfyUiDriver } from '@server/studio/drivers/comfyui.ts';
import { createStudioQueue } from '@server/studio/queue.ts';
import type { MediaSocket, MediaSocketFactory } from '@server/studio/socket.ts';
import { createAssetStorage, mimeTypeOf } from '@server/studio/storage.ts';

import { fakeMediaDriver, PNG_BYTES } from './fake-media.ts';

/**
 * The Studio's pure and near-pure parts (C10).
 *
 * Three things that a route test would exercise only by accident, and each of
 * which is where a subtle mistake would be invisible: the graph rutekit sends to
 * ComfyUI, the path it builds for a generated file, and the queue's own
 * bookkeeping. The route tests assert what an operator can see; these assert what
 * the pieces mean.
 */

/**
 * Assert a refusal, reading the message that was kept for the log.
 *
 * `AppError.internal` answers a 500 with "Something went wrong." and keeps the
 * detail on its cause (R5.9), so `toThrow(/…/)` would only ever assert the
 * generic message. The cause is where the sentence a developer needs lives.
 */
async function expectRefusal(work: Promise<unknown>, pattern: RegExp): Promise<void> {
  const error = await work.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof Error)) throw new Error(`expected a refusal, got ${String(error)}`);
  const cause = (error as { cause?: unknown }).cause;
  expect(cause instanceof Error ? cause.message : error.message).toMatch(pattern);
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'rutekit-studio-'));
}

/* ---- The ComfyUI graph ---- */

function request(overrides: Partial<MediaRequest> = {}): MediaRequest {
  return {
    kind: 'image',
    model: 'sd_xl_base_1.0.safetensors',
    prompt: 'a lighthouse at dusk',
    negativePrompt: null,
    parameters: {},
    ...overrides,
  };
}

interface Graph {
  readonly [node: string]: { readonly class_type: string; readonly inputs: Record<string, unknown> };
}

describe('the ComfyUI graph', () => {
  it('is ComfyUI’s API format, with node ids as keys', () => {
    // The UI format is an array of boxes with positions and looks almost
    // identical; posting it is the commonest way to get a 400 out of `/prompt`.
    const graph = buildGraph(request()) as unknown as Graph;
    expect(Array.isArray(graph)).toBe(false);
    for (const node of Object.values(graph)) {
      expect(typeof node.class_type).toBe('string');
      expect(typeof node.inputs).toBe('object');
    }
  });

  it('reads the model id as the checkpoint name', () => {
    // The manifest lists `sd_xl_base_1.0.safetensors` — a file on the operator's
    // own disk, not a model family — so the id is the `ckpt_name`.
    const graph = buildGraph(request()) as unknown as Graph;
    const loader = Object.values(graph).find((node) => node.class_type === 'CheckpointLoaderSimple');
    expect(loader?.inputs['ckpt_name']).toBe('sd_xl_base_1.0.safetensors');
  });

  it('wires the sampler to the checkpoint, both prompts and the latent', () => {
    const graph = buildGraph(request({ negativePrompt: 'blurry' })) as unknown as Graph;
    const sampler = Object.values(graph).find((node) => node.class_type === 'KSampler');
    expect(sampler?.inputs['positive']).toEqual([expect.any(String), 0]);
    expect(sampler?.inputs['negative']).toEqual([expect.any(String), 0]);
    expect(sampler?.inputs['latent_image']).toEqual([expect.any(String), 0]);

    const negative = Object.values(graph).find(
      (node) => node.class_type === 'CLIPTextEncode' && node.inputs['text'] === 'blurry',
    );
    expect(negative).toBeDefined();
  });

  it('sends an empty negative prompt as an empty string, not a missing node', () => {
    // A graph with no negative conditioning is one ComfyUI rejects, so "nothing"
    // has to be a node carrying nothing.
    const graph = buildGraph(request()) as unknown as Graph;
    const encoders = Object.values(graph).filter((node) => node.class_type === 'CLIPTextEncode');
    expect(encoders).toHaveLength(2);
    expect(encoders.some((node) => node.inputs['text'] === '')).toBe(true);
  });

  it('maps the aspect to a size SDXL was trained on', () => {
    const wide = buildGraph(request({ parameters: { aspect: '16:9' } })) as unknown as Graph;
    const latent = Object.values(wide).find((node) => node.class_type === 'EmptyLatentImage');
    // 16:9 taken literally would be 1024×576, which is a bucket SDXL produces
    // noticeably worse images in.
    expect(latent?.inputs['width']).toBe(1344);
    expect(latent?.inputs['height']).toBe(768);
  });

  it('falls back to 1:1 for an aspect it does not know', () => {
    const odd = buildGraph(request({ parameters: { aspect: '21:9' } })) as unknown as Graph;
    const latent = Object.values(odd).find((node) => node.class_type === 'EmptyLatentImage');
    expect(latent?.inputs['width']).toBe(1024);
  });

  it('carries steps, guidance and seed onto the sampler', () => {
    const graph = buildGraph(
      request({ parameters: { steps: 12, guidance: 3.5, seed: 42 } }),
    ) as unknown as Graph;
    const sampler = Object.values(graph).find((node) => node.class_type === 'KSampler');
    expect(sampler?.inputs['steps']).toBe(12);
    expect(sampler?.inputs['cfg']).toBe(3.5);
    expect(sampler?.inputs['seed']).toBe(42);
  });

  it('ignores a parameter of the wrong type rather than sending it', () => {
    // `parameters` is an open bag the console and the API both write; a string
    // where a number belongs is a bug upstream, and passing it through would be
    // a 400 from ComfyUI a long way from its cause.
    const graph = buildGraph(
      request({ parameters: { steps: 'many', guidance: 6.5 } }),
    ) as unknown as Graph;
    const sampler = Object.values(graph).find((node) => node.class_type === 'KSampler');
    expect(sampler?.inputs['steps']).toBe(30);
  });
});

/* ---- The driver registry ---- */

describe('the media driver registry', () => {
  it('answers null for a provider with no driver', () => {
    const drivers = createMediaDrivers({ drivers: [] });
    expect(drivers.for('fal')).toBeNull();
    expect(drivers.served()).toEqual([]);
  });

  it('names what is missing and what would work instead', () => {
    // "Not supported" with no next step is a dead end, so the refusal carries
    // both halves.
    const error = noMediaDriver('Fal', ['comfyui-local']);
    expect(error.message).toContain('Fal');
    expect(error.message).toContain('comfyui-local');
    expect(error.kind).toBe('invalid_request');
  });

  it('says so plainly when nothing has a driver at all', () => {
    expect(noMediaDriver('Fal', []).message).toContain('No media provider has a driver yet');
  });
});

/* ---- Asset storage ---- */

describe('asset storage', () => {
  it('round-trips bytes through a directory', async () => {
    const storage = createAssetStorage({ dataDir: tempDir() });
    const stored = await storage.put('asset_1', 'png', PNG_BYTES);

    expect(stored.mimeType).toBe('image/png');
    expect(stored.byteSize).toBe(PNG_BYTES.byteLength);
    expect(await storage.read('asset_1', 'png')).toEqual(PNG_BYTES);
  });

  it('names the file after the id and the extension, never after anything else', async () => {
    const dataDir = tempDir();
    const storage = createAssetStorage({ dataDir });
    await storage.put('asset_1', 'png', PNG_BYTES);

    expect(readFileSync(join(dataDir, 'studio', 'asset_1.png'))).toEqual(Buffer.from(PNG_BYTES));
  });

  it('refuses an extension rutekit does not serve', async () => {
    // The allowlist is closed on purpose: the console serves these bytes back
    // with a content type derived from the same table, so an unlisted one would
    // either be served as something it is not or as an opaque download.
    const storage = createAssetStorage({ dataDir: tempDir() });
    await expectRefusal(storage.put('asset_1', 'exe', PNG_BYTES), /does not store/);
    expect(mimeTypeOf('exe')).toBeNull();
  });

  it('cannot be walked out of, however the extension is spelled', async () => {
    // The whole reason the filename is built from an id rutekit minted rather
    // than from what a provider reported. Every one of these is refused before a
    // path exists, so there is nothing to traverse.
    const storage = createAssetStorage({ dataDir: tempDir() });
    for (const attempt of ['../../etc/passwd', 'png/../../x', 'png\u0000', '', '..']) {
      await expectRefusal(storage.put('asset_1', attempt, PNG_BYTES), /does not store/);
    }
  });

  it('refuses an asset id that is not one rutekit could have minted', async () => {
    const storage = createAssetStorage({ dataDir: tempDir() });
    for (const attempt of ['../escape', 'a/b', '', 'a'.repeat(65)]) {
      await expectRefusal(storage.put(attempt, 'png', PNG_BYTES), /asset id/);
    }
  });

  it('answers null for a file that is gone rather than throwing', async () => {
    // A row whose file is missing is a state a real install reaches — a cleaned
    // data directory, a restore without the bytes — and the route turns null into
    // a 404 that names the file.
    const storage = createAssetStorage({ dataDir: tempDir() });
    expect(await storage.read('asset_missing', 'png')).toBeNull();
  });

  it('removes a file, and is untroubled by one that is not there', async () => {
    const dataDir = tempDir();
    const storage = createAssetStorage({ dataDir });
    await storage.put('asset_1', 'png', PNG_BYTES);

    await storage.remove('asset_1', ['png', null]);
    expect(await storage.read('asset_1', 'png')).toBeNull();
    await expect(storage.remove('asset_1', ['png'])).resolves.toBeUndefined();
  });

  it('serves the content type from the extension, not from the row', () => {
    expect(mimeTypeOf('PNG')).toBe('image/png');
    expect(mimeTypeOf('mp4')).toBe('video/mp4');
    expect(mimeTypeOf('webm')).toBe('video/webm');
    expect(mimeTypeOf('mkv')).toBeNull();
  });
});

/* ---- The queue ---- */

interface QueueHarness {
  readonly queue: ReturnType<typeof createStudioQueue>;
  readonly studio: ReturnType<typeof createStudioRepository>;
  readonly published: GenerationJob[];
  readonly close: () => void;
}

function queueHarness(
  drivers: readonly MediaDriver[],
  options: { readonly concurrency?: number; readonly timeoutMs?: number } = {},
): QueueHarness {
  const persistence = openPersistence({ databaseUrl: ':memory:', dataDir: tempDir() });
  runMigrations(persistence.sqlite);
  const studio = createStudioRepository({ db: persistence.db });
  const published: GenerationJob[] = [];

  const queue = createStudioQueue({
    studio,
    drivers: createMediaDrivers({ drivers }),
    storage: createAssetStorage({ dataDir: tempDir() }),
    registry: createProviderRegistry(providerManifests),
    logger: silentLogger(),
    concurrency: options.concurrency ?? 2,
    timeoutMs: options.timeoutMs ?? 5_000,
    publish: (job) => published.push(job),
  });

  return {
    queue,
    studio,
    published,
    close: () => {
      persistence.close();
    },
  };
}

const BODY: StudioGenerateBody = {
  kind: 'image',
  providerId: 'comfyui-local',
  model: 'sd_xl_base_1.0.safetensors',
  prompt: 'a lighthouse',
  negativePrompt: null,
  parameters: {},
  count: 1,
  parentAssetId: null,
};

/** Poll until a job reaches a state it will not leave. */
async function settle(
  harness: QueueHarness,
  id: string,
  timeoutMs = 3_000,
): Promise<GenerationJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = [...harness.published].reverse().find((job) => job.id === id);
    if (last !== undefined && !['queued', 'executing', 'progress'].includes(last.status)) return last;
    if (Date.now() > deadline) {
      throw new Error(`generation ${id} did not settle; last was ${JSON.stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('the generation queue', () => {
  it('fans a batch out into that many jobs and lands a file for each', async () => {
    const driver = fakeMediaDriver();
    const harness = queueHarness([driver]);
    try {
      const jobs = harness.queue.submit({ ...BODY, count: 3 });
      expect(jobs).toHaveLength(3);
      expect(jobs.every((job) => job.status === 'queued')).toBe(true);

      for (const job of jobs) {
        const settled = await settle(harness, job.id);
        expect(settled.status).toBe('executed');
        expect(settled.progress).toBe(1);
        expect(settled.assetId).not.toBeNull();
      }
      expect(driver.requests).toHaveLength(3);
    } finally {
      harness.close();
    }
  });

  it('publishes progress as it goes, so a socket client sees it move', async () => {
    const harness = queueHarness([fakeMediaDriver({ steps: 4 })]);
    try {
      const [job] = harness.queue.submit(BODY);
      if (job === undefined) throw new Error('no job');
      await settle(harness, job.id);

      const stages = harness.published.filter((entry) => entry.id === job.id);
      expect(stages.length).toBeGreaterThan(2);
      expect(stages.some((entry) => entry.status === 'progress')).toBe(true);
      // The terminal frame is published too, so a client that only listens never
      // has to poll to learn a render finished.
      expect(stages.at(-1)?.status).toBe('executed');
    } finally {
      harness.close();
    }
  });

  it('fails a job whose provider has no driver, naming what would work', async () => {
    const harness = queueHarness([]);
    try {
      const [job] = harness.queue.submit(BODY);
      if (job === undefined) throw new Error('no job');
      const settled = await settle(harness, job.id);

      expect(settled.status).toBe('failed');
      expect(settled.error).toMatch(/no media driver/);
      expect(settled.assetId).toBeNull();
    } finally {
      harness.close();
    }
  });

  it('fails a job the driver refused, with the driver’s own words', async () => {
    const harness = queueHarness([fakeMediaDriver({ fail: 'that checkpoint is not on disk' })]);
    try {
      const [job] = harness.queue.submit(BODY);
      if (job === undefined) throw new Error('no job');
      const settled = await settle(harness, job.id);

      expect(settled.status).toBe('failed');
      expect(settled.error).toBe('that checkpoint is not on disk');
    } finally {
      harness.close();
    }
  });

  it('refuses a provider rutekit does not have', () => {
    const harness = queueHarness([fakeMediaDriver()]);
    try {
      expect(() => harness.queue.submit({ ...BODY, providerId: 'nope' })).toThrow(/No provider/);
    } finally {
      harness.close();
    }
  });

  it('cancels a job that has not started, and never runs it', async () => {
    // The cap is one and the first render hangs, so the second job stays queued
    // and is the one being cancelled — which is the case `takeNext` has to
    // respect, or a cancelled row would still be picked up.
    const driver = fakeMediaDriver({ hang: true });
    const harness = queueHarness([driver], { concurrency: 1 });
    try {
      const jobs = harness.queue.submit({ ...BODY, count: 2 });
      const [first, second] = jobs;
      if (first === undefined || second === undefined) throw new Error('no jobs');

      await settle(harness, first.id).catch(() => undefined);
      const cancelled = harness.queue.cancel(second.id);
      expect(cancelled.status).toBe('cancelled');

      harness.queue.cancel(first.id);
      expect((await settle(harness, first.id)).status).toBe('cancelled');
      expect(driver.requests).toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  it('cancels a running job, and reports it as cancelled rather than failed', async () => {
    // A cancel is not a failure: reporting it as one would send an operator
    // looking for a cause that does not exist.
    const harness = queueHarness([fakeMediaDriver({ hang: true })], { concurrency: 1 });
    try {
      const [job] = harness.queue.submit(BODY);
      if (job === undefined) throw new Error('no job');
      await settle(harness, job.id).catch(() => undefined);

      harness.queue.cancel(job.id);
      const settled = await settle(harness, job.id);
      expect(settled.status).toBe('cancelled');
      expect(settled.error).toBeNull();
    } finally {
      harness.close();
    }
  });

  it('leaves a finished job alone when it is cancelled', async () => {
    const harness = queueHarness([fakeMediaDriver()]);
    try {
      const [job] = harness.queue.submit(BODY);
      if (job === undefined) throw new Error('no job');
      const settled = await settle(harness, job.id);

      expect(harness.queue.cancel(job.id).status).toBe('executed');
      expect(harness.queue.cancel(job.id).assetId).toBe(settled.assetId);
    } finally {
      harness.close();
    }
  });

  it('runs no more than the cap at once, and drains the rest', async () => {
    let inFlight = 0;
    let peak = 0;
    const inner = fakeMediaDriver();

    // A wrapper rather than a hook on the fake, because the count has to be
    // released after the render returns — a driver that never released would
    // deadlock the test rather than fail it.
    const counting: MediaDriver = {
      providerId: inner.providerId,
      async generate(request, run) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        try {
          return await inner.generate(request, run);
        } finally {
          inFlight -= 1;
        }
      },
    };

    const harness = queueHarness([counting], { concurrency: 2 });
    try {
      const jobs = harness.queue.submit({ ...BODY, count: 4 });
      for (const job of jobs) await settle(harness, job.id);

      // The cap holds, and more than one runs — a queue that serialised would
      // pass the first assertion and fail the second.
      expect(peak).toBeLessThanOrEqual(2);
      expect(peak).toBeGreaterThan(1);
    } finally {
      harness.close();
    }
  });

  it('recovers a job the last process left running', async () => {
    // Nothing reattaches to a render that was in flight when the server stopped:
    // the driver that owned it is gone. Marking it failed is what stops a dead
    // job from sitting in the queue looking like it is still working.
    const harness = queueHarness([fakeMediaDriver({ hang: true })], { concurrency: 1 });
    try {
      const [job] = harness.queue.submit(BODY);
      if (job === undefined) throw new Error('no job');
      await settle(harness, job.id).catch(() => undefined);

      expect(harness.queue.recover()).toBe(1);
      const settled = await settle(harness, job.id);
      expect(settled.status).toBe('failed');
      expect(settled.error).toMatch(/server restarted/);
      // A second sweep has nothing left to move.
      expect(harness.queue.recover()).toBe(0);
    } finally {
      harness.close();
    }
  });

  it('carries the lineage onto the asset the render produced', async () => {
    // `Asset.parentAssetId` has been in the contract since FASE B with nothing
    // to fill it, and the composer's refine/variation/upscale could only *claim*
    // the lineage in a caption. This is the half that makes it real.
    const harness = queueHarness([fakeMediaDriver()]);
    try {
      const [job] = harness.queue.submit({ ...BODY, parentAssetId: 'asset_parent' });
      if (job === undefined) throw new Error('no job');
      const settled = await settle(harness, job.id);
      if (settled.assetId === null) throw new Error('the render produced no asset');

      expect(harness.studio.findAsset(settled.assetId)?.parentAssetId).toBe('asset_parent');
    } finally {
      harness.close();
    }
  });

  it('records the file it wrote on the asset row', async () => {
    const harness = queueHarness([fakeMediaDriver({ extension: 'webp' })]);
    try {
      const [job] = harness.queue.submit(BODY);
      if (job === undefined) throw new Error('no job');
      const settled = await settle(harness, job.id);
      if (settled.assetId === null) throw new Error('the render produced no asset');

      const asset = harness.studio.findAsset(settled.assetId);
      expect(asset?.extension).toBe('webp');
      expect(asset?.mimeType).toBe('image/webp');
      expect(asset?.byteSize).toBe(PNG_BYTES.byteLength);
    } finally {
      harness.close();
    }
  });

  it('fails a render that outruns its deadline', async () => {
    // A render that ran out of clock is a failure, not a cancel: nobody asked
    // for it to stop.
    const harness = queueHarness([fakeMediaDriver({ hang: true })], {
      concurrency: 1,
      timeoutMs: 40,
    });
    try {
      const [job] = harness.queue.submit(BODY);
      if (job === undefined) throw new Error('no job');
      expect((await settle(harness, job.id)).status).toBe('failed');
    } finally {
      harness.close();
    }
  });
});

/* ---- The ComfyUI driver against a scripted socket ---- */

/** A socket a test drives by hand. */
function scriptedSocket(): {
  readonly factory: MediaSocketFactory;
  readonly sent: string[];
  emit(message: unknown): void;
  closed(): boolean;
} {
  const sent: string[] = [];
  let onMessage: ((data: string) => void) | null = null;
  let closed = false;

  const socket: MediaSocket = {
    send: (data) => sent.push(data),
    close: () => {
      closed = true;
    },
    onMessage: (handler) => {
      onMessage = handler;
    },
    onClose: () => undefined,
    onError: () => undefined,
  };

  return {
    factory: () => socket,
    sent,
    emit: (message) => {
      onMessage?.(JSON.stringify(message));
    },
    closed: () => closed,
  };
}

/** The fetcher the driver is given, so the tests below can read as sentences. */
type ComfyFetch = Parameters<typeof createComfyUiDriver>[0]['fetch'];

describe('the ComfyUI driver', () => {
  const manifest = createProviderRegistry(providerManifests)
    .all()
    .find((entry) => entry.id === 'comfyui-local');

  function driver(fetch: ComfyFetch, socket: MediaSocketFactory) {
    if (manifest === undefined) throw new Error('the comfyui-local manifest is missing');
    return createComfyUiDriver({ manifest, fetch, socket });
  }

  function jsonFetch(body: unknown): ComfyFetch {
    return () => Promise.resolve(Response.json(body));
  }

  it('refuses video, and says why', async () => {
    // `wan2.2_t2v_14B` needs a graph with a text encoder, a VAE pair and a video
    // save node. Guessing at one would produce a job that fails inside ComfyUI
    // with a node error an operator cannot act on.
    const script = scriptedSocket();
    await expect(
      driver(jsonFetch({ prompt_id: 'p1' }), script.factory).generate(
        request({ kind: 'video', model: 'wan2.2_t2v_14B.safetensors' }),
        { onProgress: () => undefined, signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/cannot render video/);
  });

  it('submits the graph and fetches the file the socket announced', async () => {
    const script = scriptedSocket();
    const calls: string[] = [];
    const fetch: ComfyFetch = (url) => {
      calls.push(url);
      if (url.endsWith('/prompt')) return Promise.resolve(Response.json({ prompt_id: 'p1' }));
      return Promise.resolve(new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } }));
    };

    const progress: number[] = [];
    const generate = driver(fetch, script.factory).generate(request(), {
      onProgress: (entry) => {
        if (entry.progress !== null) progress.push(entry.progress);
      },
      signal: new AbortController().signal,
    });

    // The driver submits first, then waits; the socket answers once the prompt is
    // known, which is what a real ComfyUI does too.
    await new Promise((resolve) => setTimeout(resolve, 5));
    script.emit({
      type: 'progress',
      data: { prompt_id: 'p1', value: 5, max: 10 },
    });
    script.emit({
      type: 'executed',
      data: { prompt_id: 'p1', output: { images: [{ filename: 'rutekit_00001_.png', subfolder: '', type: 'output' }] } },
    });

    const output = await generate;
    expect(output.extension).toBe('png');
    expect(output.bytes).toEqual(PNG_BYTES);
    expect(calls[0]).toContain('/prompt');
    expect(calls[1]).toContain('/view?');
    expect(calls[1]).toContain('filename=rutekit_00001_.png');
    expect(progress).toContain(0.5);
    expect(script.closed()).toBe(true);
  });

  it('ignores messages about somebody else’s prompt', async () => {
    // A ComfyUI instance is shared: the operator's own browser tab is very likely
    // rendering at the same time, and every client receives every message. Taking
    // the first `executed` would hand one prompt's picture to another's job.
    const script = scriptedSocket();
    const fetch: ComfyFetch = (url) =>
      Promise.resolve(
        url.endsWith('/prompt')
          ? Response.json({ prompt_id: 'mine' })
          : new Response(PNG_BYTES, { headers: { 'content-type': 'image/png' } }),
      );

    const generate = driver(fetch, script.factory).generate(request(), {
      onProgress: () => undefined,
      signal: new AbortController().signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    script.emit({
      type: 'executed',
      data: { prompt_id: 'someone-else', output: { images: [{ filename: 'theirs.png', subfolder: '', type: 'output' }] } },
    });
    script.emit({
      type: 'executed',
      data: { prompt_id: 'mine', output: { images: [{ filename: 'mine.png', subfolder: '', type: 'output' }] } },
    });

    expect((await generate).extension).toBe('png');
  });

  it('reports a render that failed inside ComfyUI, with its reason', async () => {
    const script = scriptedSocket();
    const generate = driver(jsonFetch({ prompt_id: 'p1' }), script.factory).generate(request(), {
      onProgress: () => undefined,
      signal: new AbortController().signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    script.emit({
      type: 'execution_error',
      data: { prompt_id: 'p1', exception_message: 'CUDA out of memory' },
    });

    await expect(generate).rejects.toThrow(/CUDA out of memory/);
  });

  it('stops when the operator cancels', async () => {
    const script = scriptedSocket();
    const controller = new AbortController();
    const generate = driver(jsonFetch({ prompt_id: 'p1' }), script.factory).generate(request(), {
      onProgress: () => undefined,
      signal: controller.signal,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(generate).rejects.toBeInstanceOf(RenderCancelledError);
  });

  it('refuses a submit ComfyUI answers without naming', async () => {
    const script = scriptedSocket();
    await expect(
      driver(jsonFetch({}), script.factory).generate(request(), {
        onProgress: () => undefined,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/without naming it/);
  });
});
