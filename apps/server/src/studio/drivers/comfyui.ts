import type { ProviderManifest } from '@registry';

import { AppError } from '@server/errors.ts';
import type { ResponseFetcher } from '@server/providers/outbound.ts';
import {
  RenderCancelledError,
  type MediaDriver,
  type MediaOutput,
  type MediaRequest,
  type MediaRun,
} from '@server/studio/driver.ts';
import type { MediaSocketFactory } from '@server/studio/socket.ts';

/**
 * ComfyUI, driven over its own API (C10, FR-8.1).
 *
 * The one media provider rutekit can actually render with, and it is the right
 * one to start from: it is local, it needs no credential, its API is four
 * documented endpoints, and its vocabulary is already this contract's — the
 * `queued → executing → progress → executed` the asset schema borrows *is* the
 * ComfyUI prompt lifecycle. A driver for a hosted endpoint would have been a
 * translation; this one is a transcription.
 *
 * **The model id is a checkpoint filename.** That is not a liberty taken here:
 * `comfyui-local`'s manifest lists `sd_xl_base_1.0.safetensors` and
 * `flux1-dev.safetensors`, which are files on the operator's own disk rather than
 * model families. So the driver reads the id as the `ckpt_name` and the manifest
 * is what decided that reading was correct.
 *
 * **The graph is built here, and that is the honest limitation.** A ComfyUI
 * render is a node graph, and rutekit ships one: the standard text-to-image
 * pipeline — checkpoint, two prompts, empty latent, sampler, decode, save —
 * parameterised by the request. It covers the two image checkpoints in the
 * manifest and nothing else. **A video model is refused**, because
 * `wan2.2_t2v_14B` needs a graph with a text encoder, a VAE pair and a video
 * save node, and guessing at one would produce a job that fails inside ComfyUI
 * with a node error an operator cannot act on. Declaring a graph per model is a
 * manifest concern — the same shape of gap as Google's `thinkingConfig` in C9 —
 * and it is the follow-up rather than something to fake here.
 *
 * **Progress comes from the socket, and the socket is the only source.** `/history`
 * says whether a prompt finished, never how far along it is, so an HTTP-only
 * driver would show a bar that sits at zero and then jumps to done. The driver
 * opens ComfyUI's websocket alongside the submit and reads the same messages the
 * ComfyUI UI reads.
 */

/** The node ids the built graph uses. Arbitrary, but stable so a log line means something. */
const NODES = {
  checkpoint: '4',
  positive: '6',
  negative: '7',
  latent: '5',
  sampler: '3',
  decode: '8',
  save: '9',
} as const;

/**
 * Aspect ratio to pixel size, on a 1024 base.
 *
 * The pairs are the ones SDXL was trained on rather than a strict arithmetic
 * ratio: 16:9 taken literally would be 1024×576, which is a bucket SDXL produces
 * noticeably worse images in. A model that wants different sizes is a model whose
 * driver or manifest should say so.
 */
const SIZES: Readonly<Record<string, { readonly width: number; readonly height: number }>> = {
  '1:1': { width: 1024, height: 1024 },
  '16:9': { width: 1344, height: 768 },
  '4:3': { width: 1152, height: 896 },
  '9:16': { width: 768, height: 1344 },
};

const DEFAULT_SIZE = { width: 1024, height: 1024 };

/** ComfyUI's own defaults, used when the request carries no value for one. */
const DEFAULT_STEPS = 30;
const DEFAULT_GUIDANCE = 6.5;
const DEFAULT_SAMPLER = 'euler';
const DEFAULT_SCHEDULER = 'normal';

export interface ComfyUiDriverDeps {
  readonly manifest: ProviderManifest;
  /** The egress-checked fetcher the rest of the server uses. */
  readonly fetch: ResponseFetcher;
  readonly socket: MediaSocketFactory;
  /** Injectable so a test can assert the id rutekit sends. */
  readonly newClientId?: (() => string) | undefined;
}

/** A value the request carries as a number, or the fallback. */
function numberParam(
  parameters: Readonly<Record<string, string | number | boolean>>,
  key: string,
  fallback: number,
): number {
  const value = parameters[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringParam(
  parameters: Readonly<Record<string, string | number | boolean>>,
  key: string,
  fallback: string,
): string {
  const value = parameters[key];
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/**
 * The text-to-image graph for one request.
 *
 * ComfyUI's API format, which is the graph with node ids as keys — not the UI's
 * format, which is an array of boxes with positions. The distinction matters:
 * posting the UI format is the commonest way to get a 400 out of `/prompt`, and
 * it looks almost identical.
 */
export function buildGraph(request: MediaRequest): Record<string, unknown> {
  const size = SIZES[stringParam(request.parameters, 'aspect', '1:1')] ?? DEFAULT_SIZE;

  return {
    [NODES.checkpoint]: {
      class_type: 'CheckpointLoaderSimple',
      inputs: { ckpt_name: request.model },
    },
    [NODES.positive]: {
      class_type: 'CLIPTextEncode',
      inputs: { text: request.prompt, clip: [NODES.checkpoint, 1] },
    },
    [NODES.negative]: {
      class_type: 'CLIPTextEncode',
      // An empty string rather than an omitted node: a graph with no negative
      // conditioning is a graph ComfyUI rejects, and "nothing" is what the empty
      // prompt means.
      inputs: { text: request.negativePrompt ?? '', clip: [NODES.checkpoint, 1] },
    },
    [NODES.latent]: {
      class_type: 'EmptyLatentImage',
      inputs: { width: size.width, height: size.height, batch_size: 1 },
    },
    [NODES.sampler]: {
      class_type: 'KSampler',
      inputs: {
        seed: numberParam(request.parameters, 'seed', 0),
        steps: numberParam(request.parameters, 'steps', DEFAULT_STEPS),
        cfg: numberParam(request.parameters, 'guidance', DEFAULT_GUIDANCE),
        sampler_name: stringParam(request.parameters, 'sampler', DEFAULT_SAMPLER),
        scheduler: stringParam(request.parameters, 'scheduler', DEFAULT_SCHEDULER),
        denoise: 1,
        model: [NODES.checkpoint, 0],
        positive: [NODES.positive, 0],
        negative: [NODES.negative, 0],
        latent_image: [NODES.latent, 0],
      },
    },
    [NODES.decode]: {
      class_type: 'VAEDecode',
      inputs: { samples: [NODES.sampler, 0], vae: [NODES.checkpoint, 2] },
    },
    [NODES.save]: {
      class_type: 'SaveImage',
      inputs: { filename_prefix: 'rutekit', images: [NODES.decode, 0] },
    },
  };
}

/** One message ComfyUI sent over its socket, as far as this driver reads it. */
interface ComfyEvent {
  readonly type?: unknown;
  readonly data?: Record<string, unknown>;
}

/** The image an `executed` message announced. */
interface ComfyImage {
  readonly filename: string;
  readonly subfolder: string;
  readonly type: string;
}

function imagesOf(event: ComfyEvent): ComfyImage[] {
  const output = event.data?.['output'];
  if (output === null || typeof output !== 'object') return [];
  const images = (output as { images?: unknown }).images;
  if (!Array.isArray(images)) return [];
  return images.filter(isImage);
}

function isImage(value: unknown): value is ComfyImage {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['filename'] === 'string' &&
    typeof candidate['subfolder'] === 'string' &&
    typeof candidate['type'] === 'string'
  );
}

/** The extension of a filename, lowercased and without the dot. */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

/**
 * ComfyUI's own words for why a render failed.
 *
 * Read as a string rather than stringified: the field is `unknown` off the wire,
 * and an error that arrives as an object would be reported as `[object Object]`
 * — which is a message that says nothing and looks like a bug in rutekit rather
 * than a report from the renderer.
 */
function reasonOf(data: Record<string, unknown>): string {
  const message = data['exception_message'];
  if (typeof message === 'string' && message !== '') return message;
  const type = data['exception_type'];
  if (typeof type === 'string' && type !== '') return type;
  return 'no reason given';
}

export function createComfyUiDriver(deps: ComfyUiDriverDeps): MediaDriver {
  // A manifest may leave its base URL null — the field exists for providers with
  // an endpoint the operator's account decides. A media driver has nowhere to
  // send anything without one, so this refuses at construction: a boot that
  // fails names the manifest, while a null URL discovered mid-render is a job
  // that fails for a reason nobody can act on.
  const baseUrl = deps.manifest.endpoint.baseUrl;
  if (baseUrl === null) {
    throw new Error(`${deps.manifest.id} has no base URL, so it cannot be driven`);
  }
  const base = baseUrl.replace(/\/+$/, '');
  const socketBase = base.replace(/^http/, 'ws');
  const newClientId = deps.newClientId ?? ((): string => crypto.randomUUID());

  async function post(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await deps.fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      if (signal.aborted) throw cancelled();
      throw AppError.upstreamError(`${deps.manifest.name} could not be reached.`, {
        provider: deps.manifest.id,
        cause,
      });
    }
    if (!response.ok) {
      throw AppError.upstreamError(
        `${deps.manifest.name} refused the render (${String(response.status)}).`,
        { provider: deps.manifest.id },
      );
    }
    return response.json();
  }

  async function getBytes(url: string, signal: AbortSignal): Promise<Uint8Array> {
    const response = await deps.fetch(url, { signal });
    if (!response.ok) {
      throw AppError.upstreamError(
        `${deps.manifest.name} produced a file it would not serve back (${String(response.status)}).`,
        { provider: deps.manifest.id },
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  return {
    providerId: deps.manifest.id,

    async generate(request: MediaRequest, run: MediaRun): Promise<MediaOutput> {
      if (request.kind === 'video') {
        throw AppError.invalidRequest(
          `${deps.manifest.name} cannot render video from rutekit yet: a text-to-video graph is a different workflow from the text-to-image one, and rutekit does not have one to send. Pick an image model.`,
        );
      }

      const clientId = newClientId();
      const socket = deps.socket(`${socketBase}/ws?clientId=${encodeURIComponent(clientId)}`);

      // The socket is opened before the prompt is submitted. ComfyUI starts
      // broadcasting the moment the prompt is queued, so a socket that connected
      // afterwards would miss the first messages — including, for a fast model,
      // the one that says it finished.
      const watcher = watch(socket, run);

      // The clock is the queue's, not this driver's. It aborts `run.signal` when
      // a render outruns its ceiling, and a second timer here would be a second
      // clock that could disagree with the one the console reads.
      try {
        const submitted = await post(
          '/prompt',
          { prompt: buildGraph(request), client_id: clientId },
          run.signal,
        );
        const promptId = promptIdOf(submitted);
        run.onProgress({ progress: 0, stage: 'Queued' });

        const image = await watcher.waitFor(promptId, run.signal);
        run.onProgress({ progress: 1, stage: 'Fetching the file' });

        const query = new URLSearchParams({
          filename: image.filename,
          subfolder: image.subfolder,
          type: image.type,
        });
        const bytes = await getBytes(`${base}/view?${query.toString()}`, run.signal);

        return {
          extension: extensionOf(image.filename),
          bytes,
          // ComfyUI's `/view` returns the pixels and no dimensions, and reading
          // them out of a PNG header is a decoder rutekit does not have. Null is
          // the contract's own "not known", which the console renders by leaving
          // the size line out.
          width: null,
          height: null,
          durationSeconds: null,
        };
      } finally {
        watcher.stop();
        socket.close();
      }
    },
  };
}

function cancelled(): RenderCancelledError {
  return new RenderCancelledError();
}

/** The prompt id ComfyUI answered the submit with. */
function promptIdOf(body: unknown): string {
  if (body !== null && typeof body === 'object') {
    const value = (body as { prompt_id?: unknown }).prompt_id;
    if (typeof value === 'string' && value !== '') return value;
  }
  throw AppError.upstreamError('ComfyUI accepted the render without naming it.');
}

interface Watcher {
  /** Resolves with the image once the prompt is done; rejects on an execution error. */
  waitFor(promptId: string, signal: AbortSignal): Promise<ComfyImage>;
  stop(): void;
}

/**
 * Read ComfyUI's socket until the prompt this driver submitted is done.
 *
 * **Filtered by prompt id, which is not optional.** A ComfyUI instance is shared
 * — the operator's own browser tab is very likely rendering something at the same
 * time — and every connected client receives every client's messages. A driver
 * that took the first `executed` it saw would hand one prompt's picture to
 * another prompt's job, which is a bug that looks like a corrupted gallery.
 *
 * Progress is read as `value / max` from the sampler node. A message that is not
 * about this prompt is dropped rather than counted, so a busy instance does not
 * make a job look further along than it is.
 */
function watch(socket: ReturnType<MediaSocketFactory>, run: MediaRun): Watcher {
  let resolveOutput: ((image: ComfyImage) => void) | null = null;
  let rejectOutput: ((error: unknown) => void) | null = null;
  let wanted: string | null = null;
  let done = false;

  const finish = (outcome: { image: ComfyImage } | { error: unknown }): void => {
    if (done) return;
    done = true;
    if ('image' in outcome) resolveOutput?.(outcome.image);
    else rejectOutput?.(outcome.error);
  };

  socket.onMessage((raw) => {
    let event: ComfyEvent;
    try {
      event = JSON.parse(raw) as ComfyEvent;
    } catch {
      // ComfyUI sends JSON and nothing else; a frame that is not JSON is not part
      // of this conversation, so it is ignored rather than treated as a failure.
      return;
    }
    const data = event.data ?? {};
    const forUs = data['prompt_id'] === wanted;
    if (!forUs) return;

    switch (event.type) {
      case 'execution_start':
        run.onProgress({ progress: null, stage: 'Loading the model' });
        break;
      case 'progress': {
        const value = data['value'];
        const max = data['max'];
        run.onProgress({
          progress:
            typeof value === 'number' && typeof max === 'number' && max > 0 ? value / max : null,
          stage: 'Sampling',
        });
        break;
      }
      case 'executing': {
        // A null node is ComfyUI saying the prompt is finished; the output
        // arrives on `executed`, which is what actually resolves this.
        if (data['node'] === null) run.onProgress({ progress: 1, stage: 'Finishing' });
        break;
      }
      case 'executed': {
        const images = imagesOf(event);
        const first = images[0];
        if (first !== undefined) finish({ image: first });
        break;
      }
      case 'execution_error':
        finish({
          error: AppError.upstreamError(
            `The render failed inside ComfyUI (${reasonOf(data)}).`,
          ),
        });
        break;
      case 'execution_cached':
        break;
      default:
        break;
    }
  });

  socket.onError((error) => {
    finish({
      error: AppError.upstreamError('The connection to ComfyUI dropped mid-render.', { cause: error }),
    });
  });

  socket.onClose(() => {
    // A socket that closes before the output arrived is a render that will never
    // report one — the instance restarted, or the network went. Saying so is
    // better than a job that waits for ever.
    finish({ error: AppError.upstreamError('ComfyUI closed the connection before the render finished.') });
  });

  return {
    waitFor(promptId, signal): Promise<ComfyImage> {
      wanted = promptId;
      return new Promise<ComfyImage>((resolve, reject) => {
        resolveOutput = resolve;
        rejectOutput = reject;
        signal.addEventListener(
          'abort',
          () => {
            finish({ error: cancelled() });
          },
          { once: true },
        );
      });
    },
    stop(): void {
      done = true;
    },
  };
}
