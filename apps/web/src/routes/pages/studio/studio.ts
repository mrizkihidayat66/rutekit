import type { Asset, AssetKind, GenerationJob, GenerationJobStatus } from '@contracts';

import type { Tone } from '@web/components/patterns/tone.ts';
import { formatBytes, formatSpan } from '@web/lib/format.ts';

/**
 * The Studio's words, and the bridge between an asset and the draft that
 * produced it.
 *
 * Nothing here renders. The page, the sidebar, the gallery and the detail drawer
 * all speak about the same records — an asset, a generation job, the bag of
 * parameters a diffusion endpoint takes — so the labels, the ranges and the
 * conversions live here once rather than being re-spelled per component and
 * drifting apart.
 *
 * The parameter bag is the part worth explaining. `generationJobSchema.parameters`
 * is an open record rather than a fixed shape, because every endpoint spells its
 * own knobs differently (a ComfyUI graph has no `guidance`, a video model has no
 * `steps` in the same sense). The Studio therefore reads and writes the four keys
 * it knows — `aspect`, `steps`, `guidance`, `seed` — and passes anything else
 * through untouched, which is what lets an asset generated elsewhere still show
 * its own metadata in the detail view.
 */

/* ---- URL ---- */

/** The asset the detail drawer is showing, so a render is a link. */
export const STUDIO_PARAM = 'asset';
/** Which of the three panes is up: the image grid, the video grid, the queue. */
export const VIEW_PARAM = 'view';
export const STAR_PARAM = 'starred';
export const SEARCH_PARAM = 'asset_q';

export type StudioView = 'images' | 'videos' | 'queue';

export const STUDIO_VIEWS: readonly StudioView[] = ['images', 'videos', 'queue'];

export const VIEW_LABELS: Record<StudioView, string> = {
  images: 'Images',
  videos: 'Videos',
  queue: 'Queue',
};

export function isStudioView(value: string): value is StudioView {
  return STUDIO_VIEWS.includes(value as StudioView);
}

/* ---- Generation parameters ---- */

export const ASPECTS = ['1:1', '16:9', '4:3', '9:16'] as const;
export type Aspect = (typeof ASPECTS)[number];

export const ASPECT_OPTIONS: readonly { readonly value: Aspect; readonly label: string }[] =
  ASPECTS.map((value) => ({ value, label: value }));

export function isAspect(value: string): value is Aspect {
  return ASPECTS.includes(value as Aspect);
}

/**
 * The ranges the sliders cover.
 *
 * They are wider than any one endpoint's limits on purpose: the Studio is a
 * front end for whichever generator is behind the provider, and clamping a
 * value here would mean an endpoint that accepts 150 steps is unreachable from
 * the console. A provider that refuses a value says so in the job's error, which
 * is where the operator will look anyway.
 */
export const STEPS_RANGE = { min: 4, max: 80, step: 1 } as const;
export const GUIDANCE_RANGE = { min: 0, max: 20, step: 0.5 } as const;
export const BATCH_RANGE = { min: 1, max: 8 } as const;

export const DEFAULT_STEPS = 30;
export const DEFAULT_GUIDANCE = 6.5;

/** Grid pages are small so the first screen lands before the scroll does. */
export const GALLERY_PAGE = 24;

/** Queue rows are taller than tiles, so fewer fit a page. */
export const QUEUE_PAGE = 20;

/** The largest seed the diffusion endpoints take. */
const SEED_CEILING = 2_147_483_647;

export function randomSeed(): number {
  return Math.floor(Math.random() * SEED_CEILING) + 1;
}

export const KIND_LABELS: Record<AssetKind, string> = {
  image: 'Image',
  video: 'Video',
};

/** Everything the composer and the parameter panel hold, before it is sent. */
export interface StudioDraft {
  readonly kind: AssetKind;
  readonly providerId: string | null;
  readonly model: string | null;
  readonly prompt: string;
  /** Empty rather than null: a text field has no way to hold "no value". */
  readonly negativePrompt: string;
  readonly aspect: Aspect;
  readonly steps: number;
  readonly guidance: number;
  readonly seed: number;
  readonly count: number;
  /** Set by the upscale action; rides in `parameters` as `upscale: '2x'`. */
  readonly upscale: boolean;
  /** The asset this draft was seeded from, for the composer's caption. */
  readonly origin: string | null;
}

export function emptyDraft(): StudioDraft {
  return {
    kind: 'image',
    providerId: null,
    model: null,
    prompt: '',
    negativePrompt: '',
    aspect: '1:1',
    steps: DEFAULT_STEPS,
    guidance: DEFAULT_GUIDANCE,
    seed: randomSeed(),
    count: 1,
    upscale: false,
    origin: null,
  };
}

export function buildParameters(draft: StudioDraft): Record<string, string | number | boolean> {
  return {
    aspect: draft.aspect,
    steps: draft.steps,
    guidance: draft.guidance,
    seed: draft.seed,
    ...(draft.upscale ? { upscale: '2x' } : {}),
  };
}

export type ReuseMode = 'refine' | 'variation' | 'upscale';

export const REUSE_LABELS: Record<ReuseMode, string> = {
  refine: 'Refine',
  variation: 'Variation',
  upscale: 'Upscale',
};

export const REUSE_HINTS: Record<ReuseMode, string> = {
  refine: 'Load this prompt and its settings so it can be steered further.',
  variation: 'Load this prompt and its settings with a fresh seed.',
  upscale: 'Load this prompt and its settings, asking for a 2× render.',
};

function readNumber(parameters: Asset['parameters'], key: string, fallback: number): number {
  const value = parameters[key];
  return typeof value === 'number' ? value : fallback;
}

/** The fields an asset and a job both carry, which is all a draft is read from. */
type DraftSource = Pick<
  Asset,
  'kind' | 'providerId' | 'model' | 'prompt' | 'negativePrompt' | 'parameters'
>;

function draftFrom(source: DraftSource, mode: ReuseMode, origin: string | null): StudioDraft {
  const aspectValue = source.parameters['aspect'];
  return {
    kind: source.kind,
    providerId: source.providerId,
    model: source.model,
    prompt: source.prompt,
    negativePrompt: source.negativePrompt ?? '',
    aspect: typeof aspectValue === 'string' && isAspect(aspectValue) ? aspectValue : '1:1',
    steps: readNumber(source.parameters, 'steps', DEFAULT_STEPS),
    guidance: readNumber(source.parameters, 'guidance', DEFAULT_GUIDANCE),
    seed: mode === 'variation' ? randomSeed() : readNumber(source.parameters, 'seed', randomSeed()),
    count: 1,
    upscale: mode === 'upscale',
    origin,
  };
}

/**
 * An asset's own settings, loaded back into the composer.
 *
 * The three reuse actions differ in exactly one field each — refine keeps the
 * seed, variation rolls a new one, upscale adds the flag — which is why they
 * share one reader rather than three that would agree today and diverge later.
 *
 * `origin` travels as `parentAssetId`, so a refined render really is recorded as
 * a descendant of the one it came from: the asset row carries the link, and the
 * composer names it while the draft is still being written.
 */
export function draftFromAsset(asset: Asset, mode: ReuseMode): StudioDraft {
  return draftFrom(asset, mode, asset.id);
}

/**
 * The same reader, fed a job rather than an asset.
 *
 * A job that failed or was cancelled still holds the prompt and the parameters
 * that were asked for, which is exactly what an operator wants back after a
 * rejected render — the settings are the expensive part to retype, not the
 * picture that never arrived.
 */
export function draftFromJob(job: GenerationJob): StudioDraft {
  return draftFrom(job, 'refine', null);
}

/* ---- Generation status ---- */

/**
 * The six states a job moves through, in the operator's words.
 *
 * `executing` and `progress` are both "working" but they are not the same
 * moment: one is a worker pulling the model in, the other is pixels coming out.
 * A single "Running" would hide the difference between a job that has started
 * and one that is producing, which is the difference between waiting and
 * wondering whether it is stuck.
 */
export const GENERATION_STATUS_LABELS: Record<GenerationJobStatus, string> = {
  queued: 'Queued',
  executing: 'Starting',
  progress: 'Sampling',
  executed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const GENERATION_STATUS_TONES: Record<GenerationJobStatus, Tone> = {
  queued: 'neutral',
  executing: 'accent',
  progress: 'accent',
  executed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};

export const LIVE_GENERATION_STATUSES: readonly GenerationJobStatus[] = [
  'queued',
  'executing',
  'progress',
];

export function isLiveGeneration(job: GenerationJob): boolean {
  return LIVE_GENERATION_STATUSES.includes(job.status);
}

/** `0..1` while it is still moving, `null` when there is nothing to draw. */
export function generationProgress(job: GenerationJob): number | null {
  if (job.status === 'executed') return 1;
  return job.progress;
}

/* ---- Asset presentation ---- */

/** The first line of a prompt, short enough for a tile caption. */
export function promptTitle(prompt: string): string {
  const line = prompt.trim().split('\n')[0] ?? '';
  return line.length > 72 ? `${line.slice(0, 69)}…` : line;
}

export function assetTitle(asset: Asset): string {
  return promptTitle(asset.prompt);
}

/** Dimensions, duration when there is one, and weight — one muted line. */
export function assetMeta(asset: Asset): string {
  const size =
    asset.width === null || asset.height === null ? null : `${asset.width}×${asset.height}`;
  const duration = asset.durationSeconds === null ? null : formatSpan(asset.durationSeconds);
  return [size, duration, formatBytes(asset.byteSize)].filter((part) => part !== null).join(' · ');
}

/**
 * Human labels for the parameters worth naming, with anything unknown left as
 * its own key. An endpoint's private knob is better shown under its real name
 * than hidden or guessed at.
 */
const PARAM_LABELS: Record<string, string> = {
  aspect: 'Aspect',
  steps: 'Steps',
  guidance: 'Guidance',
  seed: 'Seed',
  upscale: 'Upscale',
};

export interface ParameterRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

export function parameterRows(
  parameters: Readonly<Record<string, string | number | boolean>>,
): readonly ParameterRow[] {
  return Object.entries(parameters)
    .map(([key, value]) => ({
      key,
      label: PARAM_LABELS[key] ?? key,
      value: typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}
