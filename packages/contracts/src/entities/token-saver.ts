import { z } from 'zod';
import { isoDateTimeSchema, timeWindowSchema } from '../common.ts';

/**
 * The request-compression pipeline, as the operator configures it.
 *
 * Five stages run in order over an outbound request — tool schemas first, then
 * the conversation, then the system prompt, then the cache boundary. Each stage
 * is independent and fail-open: an error anywhere returns the request untouched
 * rather than breaking the call, so the worst case of a misconfiguration is that
 * it saves nothing, never that it drops a turn.
 *
 * The ids are the wire vocabulary — the same strings the server reads to decide
 * which stages to run. Presentation copy (labels, descriptions, savings ranges)
 * lives with the page, not here.
 */

export const compressionStageIdSchema = z.enum(['tsc', 'dcp', 'rtk', 'caveman', 'cacheMarkers']);
export type CompressionStageId = z.infer<typeof compressionStageIdSchema>;

export const COMPRESSION_STAGE_IDS = compressionStageIdSchema.options;

/** Whether a stage can be reversed by the model, or only shapes the request. */
export const compressionNatureSchema = z.enum(['lossless', 'lossy', 'structural']);
export type CompressionNature = z.infer<typeof compressionNatureSchema>;

/**
 * The per-tool filters RTK applies. Each targets one shape of tool result — a
 * diff, a directory listing, a log — so the operator can keep the ones that
 * help and drop the ones that mangle a result they need intact.
 *
 * The reference implementation names eleven of these; `cat` completes the file
 * family alongside `readNumbered`, which is the shape a plain file read
 * returns.
 */
export const rtkFilterIdSchema = z.enum([
  'gitDiff',
  'gitStatus',
  'grep',
  'find',
  'searchList',
  'ls',
  'tree',
  'dedupLog',
  'buildOutput',
  'readNumbered',
  'smartTruncate',
  'cat',
]);
export type RtkFilterId = z.infer<typeof rtkFilterIdSchema>;

export const RTK_FILTER_IDS = rtkFilterIdSchema.options;

export const rtkFilterGroupSchema = z.enum(['git', 'search', 'listing', 'log', 'truncate']);
export type RtkFilterGroup = z.infer<typeof rtkFilterGroupSchema>;

export const RTK_FILTER_GROUPS = rtkFilterGroupSchema.options;

/** Which group a filter is shown under. Every filter belongs to exactly one. */
export const RTK_FILTER_GROUP_OF: Record<RtkFilterId, RtkFilterGroup> = {
  gitDiff: 'git',
  gitStatus: 'git',
  grep: 'search',
  find: 'search',
  searchList: 'search',
  ls: 'listing',
  tree: 'listing',
  dedupLog: 'log',
  buildOutput: 'log',
  readNumbered: 'truncate',
  smartTruncate: 'truncate',
  cat: 'truncate',
};

/** A named starting point for the filter set; the operator can then fine-tune. */
export const rtkPresetSchema = z.enum(['conservative', 'balanced', 'aggressive']);
export type RtkPreset = z.infer<typeof rtkPresetSchema>;

export const RTK_PRESETS = rtkPresetSchema.options;

/**
 * What each preset turns on. Conservative keeps only the filters that reformat
 * a result without dropping any of it; balanced adds the ones that drop
 * redundant lines but keep head and tail; aggressive turns on everything,
 * including the blunt truncation of a whole result.
 */
export const RTK_PRESET_FILTERS: Record<RtkPreset, Record<RtkFilterId, boolean>> = {
  conservative: {
    gitDiff: false,
    gitStatus: true,
    grep: true,
    find: true,
    searchList: true,
    ls: true,
    tree: true,
    dedupLog: true,
    buildOutput: true,
    readNumbered: false,
    smartTruncate: false,
    cat: false,
  },
  balanced: {
    gitDiff: true,
    gitStatus: true,
    grep: true,
    find: true,
    searchList: true,
    ls: true,
    tree: true,
    dedupLog: true,
    buildOutput: true,
    readNumbered: true,
    smartTruncate: false,
    cat: false,
  },
  aggressive: {
    gitDiff: true,
    gitStatus: true,
    grep: true,
    find: true,
    searchList: true,
    ls: true,
    tree: true,
    dedupLog: true,
    buildOutput: true,
    readNumbered: true,
    smartTruncate: true,
    cat: true,
  },
};

/**
 * How hard Caveman rewrites the system prompt. `off` is the default because it
 * is the only lossy stage that touches instructions rather than tool output, so
 * turning it on is a deliberate trade of precision for tokens.
 */
export const cavemanTierSchema = z.enum(['off', 'lite', 'full', 'ultra']);
export type CavemanTier = z.infer<typeof cavemanTierSchema>;

export const CAVEMAN_TIERS = cavemanTierSchema.options;

export const tokenSaverConfigSchema = z.object({
  /** The master switch. Off means the request is forwarded byte-for-byte. */
  enabled: z.boolean(),
  /** Per-stage on/off; `rtk` and `caveman` are inert when their detail is off. */
  stages: z.record(compressionStageIdSchema, z.boolean()),
  rtkPreset: rtkPresetSchema,
  /** Per-filter on/off, keyed by filter id. Every filter always has a state. */
  rtkFilters: z.record(rtkFilterIdSchema, z.boolean()),
  cavemanTier: cavemanTierSchema,
  updatedAt: isoDateTimeSchema,
});
export type TokenSaverConfig = z.infer<typeof tokenSaverConfigSchema>;

/** What one stage removed, so the page can show where the savings came from. */
export const tokenSaverStageSavingsSchema = z.object({
  stageId: compressionStageIdSchema,
  bytesIn: z.number().int().nonnegative(),
  bytesOut: z.number().int().nonnegative(),
  tokensSaved: z.number().int().nonnegative(),
});
export type TokenSaverStageSavings = z.infer<typeof tokenSaverStageSavingsSchema>;

/** One day's saving, for the trend line. */
export const tokenSaverSavingsPointSchema = z.object({
  date: isoDateTimeSchema,
  tokensSaved: z.number().int().nonnegative(),
});
export type TokenSaverSavingsPoint = z.infer<typeof tokenSaverSavingsPointSchema>;

export const tokenSaverSavingsSchema = z.object({
  window: timeWindowSchema,
  requestsProcessed: z.number().int().nonnegative(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  tokensSaved: z.number().int().nonnegative(),
  /** `tokensSaved / tokensIn`, already clamped to 0..1. */
  ratio: z.number().min(0).max(1),
  perStage: z.array(tokenSaverStageSavingsSchema),
  series: z.array(tokenSaverSavingsPointSchema),
});
export type TokenSaverSavings = z.infer<typeof tokenSaverSavingsSchema>;
