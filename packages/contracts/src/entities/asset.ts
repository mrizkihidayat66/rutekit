import { z } from 'zod';
import { isoDateTimeSchema } from '../common.ts';

/**
 * Studio assets (FR-8.x). A generation is an asynchronous job whose terminal
 * event carries an asset — the vocabulary (`queued → executing → progress →
 * executed`) is deliberately the one ComfyUI users already know.
 */
export const assetKindSchema = z.enum(['image', 'video']);

export const generationJobStatusSchema = z.enum([
  'queued',
  'executing',
  'progress',
  'executed',
  'failed',
  'cancelled',
]);

export const generationJobSchema = z.object({
  id: z.string(),
  kind: assetKindSchema,
  status: generationJobStatusSchema,
  providerId: z.string(),
  model: z.string(),
  prompt: z.string(),
  negativePrompt: z.string().nullable(),
  /** 0–1; null while queued or when the provider reports no progress. */
  progress: z.number().min(0).max(1).nullable(),
  /** Human-readable stage label streamed alongside progress. */
  stage: z.string().nullable(),
  /** Set once status is `executed`. */
  assetId: z.string().nullable(),
  error: z.string().nullable(),
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
});

export const assetSchema = z.object({
  id: z.string(),
  kind: assetKindSchema,
  /** URL served by the backend; the file itself lives under RUTEKIT_DATA_DIR. */
  url: z.string(),
  /** Small inline preview as a data URL, used by the gallery grid. */
  thumbnailUrl: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  /** Seconds; null for images. */
  durationSeconds: z.number().positive().nullable(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  providerId: z.string(),
  model: z.string(),
  prompt: z.string(),
  negativePrompt: z.string().nullable(),
  /** Seed and other provider parameters, preserved for "re-run with tweak". */
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  /** Id of the asset this was refined/upscaled/varied from. */
  parentAssetId: z.string().nullable(),
  favorite: z.boolean(),
  createdAt: isoDateTimeSchema,
});

export type AssetKind = z.infer<typeof assetKindSchema>;
export type GenerationJobStatus = z.infer<typeof generationJobStatusSchema>;
export type GenerationJob = z.infer<typeof generationJobSchema>;
export type Asset = z.infer<typeof assetSchema>;
