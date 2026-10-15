import type {
  CavemanTier,
  CompressionNature,
  CompressionStageId,
  RtkFilterGroup,
  RtkFilterId,
  RtkPreset,
  TimeWindow,
} from '@contracts';
import {
  RTK_FILTER_GROUPS,
  RTK_FILTER_GROUP_OF,
  RTK_FILTER_IDS,
  RTK_PRESET_FILTERS,
  TIME_WINDOWS,
} from '@contracts';

import type { Tone } from '@web/components/patterns/tone.ts';

/**
 * The Token Saver page's vocabulary.
 *
 * Kept out of the components so those files stay components-only for the
 * fast-refresh boundary, and so the page and its parts agree on what each
 * choice means.
 *
 * The five stages are not interchangeable knobs: two are lossless, one is
 * structural, and two rewrite content in a way the model cannot recover. Every
 * label here says which it is, because the operator's decision turns entirely
 * on that — a lossless stage can be left on without thinking about it, and a
 * lossy one cannot.
 */

export interface StageMeta {
  readonly id: CompressionStageId;
  /** The stage's full name, as the references give it. */
  readonly label: string;
  /** A two-word name for a bar list, where the full one would wrap. */
  readonly short: string;
  readonly description: string;
  readonly nature: CompressionNature;
  /** What the stage typically removes, as the audits measured it. */
  readonly savings: string;
}

const STAGE_META: Record<CompressionStageId, StageMeta> = {
  tsc: {
    id: 'tsc',
    label: 'Tool Schema Compaction',
    short: 'Tool schemas',
    description:
      'Rewrites the tool definitions a request carries — JSON whitespace out, `$schema` and `$id` dropped. The model reads the same schema, written more tightly.',
    nature: 'lossless',
    savings: '5–25% of tool bytes',
  },
  dcp: {
    id: 'dcp',
    label: 'Context Deduplication',
    short: 'Duplicates',
    description:
      'Finds repeated read-only tool calls — the same file read twice, the same search run again — and replaces the older copy with a stub pointing at the first.',
    nature: 'lossless',
    savings: 'grows with repetition',
  },
  rtk: {
    id: 'rtk',
    label: 'Tool Result Compression',
    short: 'Tool results',
    description:
      'Shrinks large tool results in older turns, each shape handled by its own filter — a diff, a listing, a log. This is the lossy workhorse: what a filter drops is gone.',
    nature: 'lossy',
    savings: 'up to ~35% of tool output',
  },
  caveman: {
    id: 'caveman',
    label: 'System Prompt Compaction',
    short: 'System prompt',
    description:
      'Rewrites the system prompt into a shorter form. The only stage that touches instructions rather than tool output, which is why it stays off until a level is chosen.',
    nature: 'lossy',
    savings: '5–70%, by level',
  },
  cacheMarkers: {
    id: 'cacheMarkers',
    label: 'Cache Markers',
    short: 'Cache markers',
    description:
      'Marks where the reusable prefix ends so the provider can cache it. Removes no bytes on its own — it makes every other stage’s savings cheaper to send.',
    nature: 'structural',
    savings: 'no bytes removed',
  },
};

/** The five stages in the order they run. */
export const STAGES: readonly StageMeta[] = [
  STAGE_META.tsc,
  STAGE_META.dcp,
  STAGE_META.rtk,
  STAGE_META.caveman,
  STAGE_META.cacheMarkers,
];

export function stageMeta(id: CompressionStageId): StageMeta {
  return STAGE_META[id];
}

export const NATURE_LABELS: Record<CompressionNature, string> = {
  lossless: 'Lossless',
  lossy: 'Lossy',
  structural: 'Structural',
};

/** The bar colour and the badge tone both follow nature, so the two agree. */
export const NATURE_TONES: Record<CompressionNature, Tone> = {
  lossless: 'success',
  lossy: 'warning',
  structural: 'info',
};

export interface FilterMeta {
  readonly id: RtkFilterId;
  readonly label: string;
  readonly description: string;
}

const FILTER_META: Record<RtkFilterId, FilterMeta> = {
  gitDiff: {
    id: 'gitDiff',
    label: 'Git diff',
    description: 'Keeps hunk headers, drops unchanged context lines.',
  },
  gitStatus: {
    id: 'gitStatus',
    label: 'Git status',
    description: 'Groups files by state instead of listing every path.',
  },
  grep: {
    id: 'grep',
    label: 'Grep results',
    description: 'Keeps the top match per file and counts the rest.',
  },
  find: {
    id: 'find',
    label: 'Find results',
    description: 'Collapses long path lists into a count per directory.',
  },
  searchList: {
    id: 'searchList',
    label: 'Search lists',
    description: 'Trims ranked result lists to the leading entries.',
  },
  ls: {
    id: 'ls',
    label: 'Directory listing',
    description: 'One line per entry, permissions and size compacted.',
  },
  tree: {
    id: 'tree',
    label: 'Directory tree',
    description: 'Bounds the depth and folds wide branches.',
  },
  dedupLog: {
    id: 'dedupLog',
    label: 'Log deduplication',
    description: 'Collapses repeated lines into one, with a count.',
  },
  buildOutput: {
    id: 'buildOutput',
    label: 'Build output',
    description: 'Drops progress and timing noise, keeps errors.',
  },
  readNumbered: {
    id: 'readNumbered',
    label: 'Numbered reads',
    description: 'Keeps the head and tail of a long numbered file.',
  },
  smartTruncate: {
    id: 'smartTruncate',
    label: 'Smart truncation',
    description: 'Cuts the middle of an oversized result, marking the gap.',
  },
  cat: {
    id: 'cat',
    label: 'Plain file reads',
    description: 'Trims the middle of a whole-file read.',
  },
};

export const FILTERS: readonly FilterMeta[] = RTK_FILTER_IDS.map((id) => FILTER_META[id]);

export const GROUP_LABELS: Record<RtkFilterGroup, string> = {
  git: 'Git',
  search: 'Search',
  listing: 'Listing',
  log: 'Log & build',
  truncate: 'Truncate',
};

export const GROUP_HINTS: Record<RtkFilterGroup, string> = {
  git: 'Diff and status output.',
  search: 'Grep, find and ranked result lists.',
  listing: 'Directory listings and trees.',
  log: 'Repeated logs and build output.',
  truncate: 'Whole results cut down to head and tail.',
};

/** The filters, grouped the way the page draws them. Every filter appears once. */
export const FILTERS_BY_GROUP: readonly {
  group: RtkFilterGroup;
  filters: readonly FilterMeta[];
}[] = RTK_FILTER_GROUPS.map((group) => ({
  group,
  filters: FILTERS.filter((filter) => RTK_FILTER_GROUP_OF[filter.id] === group),
}));

export const PRESET_LABELS: Record<RtkPreset, string> = {
  conservative: 'Conservative',
  balanced: 'Balanced',
  aggressive: 'Aggressive',
};

export const PRESET_HINTS: Record<RtkPreset, string> = {
  conservative: 'Only reformats — no filter drops a line. The safest setting.',
  balanced: 'Adds the filters that keep head and tail but drop redundant middles.',
  aggressive: 'Every filter on, including the blunt truncation of a whole result.',
};

/** Whether the live filter set is exactly what a preset would produce. */
export function matchesPreset(filters: Record<RtkFilterId, boolean>, preset: RtkPreset): boolean {
  const target = RTK_PRESET_FILTERS[preset];
  return RTK_FILTER_IDS.every((id) => filters[id] === target[id]);
}

/** How many filters are on, so the row can say it without walking the map again. */
export function countEnabledFilters(filters: Record<RtkFilterId, boolean>): number {
  return RTK_FILTER_IDS.filter((id) => filters[id]).length;
}

export const TIER_LABELS: Record<CavemanTier, string> = {
  off: 'Off',
  lite: 'Lite',
  full: 'Full',
  ultra: 'Ultra',
};

export const TIER_SAVINGS: Record<CavemanTier, string> = {
  off: 'No rewrite',
  lite: '~5–15%',
  full: '~30–50%',
  ultra: '~50–70%',
};

export const TIER_HINTS: Record<CavemanTier, string> = {
  off: 'The system prompt is forwarded exactly as written.',
  lite: 'Drops filler and hedging, keeps every instruction and its wording.',
  full: 'Rewrites prose as bullets, merging what repeats.',
  ultra: 'Telegraphic form — the most savings, and the most risk of losing a nuance.',
};

/** A filter map with one entry changed, typed so the patch stays a full record. */
export function withFilter(
  filters: Record<RtkFilterId, boolean>,
  id: RtkFilterId,
  on: boolean,
): Record<RtkFilterId, boolean> {
  return { ...filters, [id]: on };
}

/** A stage map with one entry changed. */
export function withStage(
  stages: Record<CompressionStageId, boolean>,
  id: CompressionStageId,
  on: boolean,
): Record<CompressionStageId, boolean> {
  return { ...stages, [id]: on };
}

export const SAVINGS_WINDOWS = TIME_WINDOWS;
export const DEFAULT_SAVINGS_WINDOW: TimeWindow = '7d';

export const WINDOW_LABELS: Record<TimeWindow, string> = {
  '1h': '1h',
  '6h': '6h',
  '12h': '12h',
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
  all: 'All',
};

/** Reads as a clause in a card description — "over the last 7 days". */
export const WINDOW_PHRASE: Record<TimeWindow, string> = {
  '1h': 'the last hour',
  '6h': 'the last 6 hours',
  '12h': 'the last 12 hours',
  '24h': 'the last 24 hours',
  '7d': 'the last 7 days',
  '30d': 'the last 30 days',
  all: 'all time',
};

/** A bucket narrower than a day is labelled by the hour, not the date. */
export function isSubDay(window: TimeWindow): boolean {
  return window === '1h' || window === '6h' || window === '12h' || window === '24h';
}
