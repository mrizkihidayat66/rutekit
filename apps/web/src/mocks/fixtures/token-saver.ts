import type {
  CompressionStageId,
  RtkFilterId,
  TimeWindow,
  TokenSaverConfig,
  TokenSaverSavings,
  TokenSaverStageSavings,
} from '@contracts';
import { RTK_PRESET_FILTERS } from '@contracts';

import { daysAgo, hoursAgo, minutesAgo } from '../clock.ts';
import type { Rng } from '../random.ts';

/**
 * The compression pipeline's settings and the savings it claims to have made.
 *
 * The settings start where a careful operator would: the two lossless stages
 * and the structural one on, Caveman off (it rewrites instructions, so it is
 * opt-in), and RTK on at the balanced preset. Everything else is a toggle away.
 *
 * The savings are synthetic — the mock proxies no traffic, so there is nothing
 * real to measure — but they are *consistent*: the per-stage figures add up to
 * the total, the ratio matches the two token counts, and the trend line is
 * shaped by the same numbers. A page that reads them cannot catch them out.
 */

/** Bytes a stage sees per request, before it does anything. */
const STAGE_BYTES_IN: Record<CompressionStageId, number> = {
  tsc: 18_400,
  dcp: 22_100,
  rtk: 96_500,
  caveman: 4_200,
  cacheMarkers: 141_000,
};

/** The fraction a stage removes when it runs. `cacheMarkers` removes nothing. */
const STAGE_RATIO: Record<CompressionStageId, number> = {
  tsc: 0.17,
  dcp: 0.09,
  rtk: 0.34,
  caveman: 0.41,
  cacheMarkers: 0,
};

/** Roughly four characters to the token, which is close enough for a mock. */
const BYTES_PER_TOKEN = 4;

export function buildTokenSaverConfig(): TokenSaverConfig {
  return {
    enabled: true,
    stages: {
      tsc: true,
      dcp: true,
      rtk: true,
      caveman: false,
      cacheMarkers: true,
    },
    rtkPreset: 'balanced',
    rtkFilters: { ...RTK_PRESET_FILTERS.balanced },
    cavemanTier: 'off',
    updatedAt: hoursAgo(31),
  };
}

/** How many points the trend line carries, and how far back each one sits. */
function seriesStamps(window: TimeWindow): readonly string[] {
  const count = (n: number): number[] => Array.from({ length: n }, (_, index) => n - 1 - index);

  switch (window) {
    case '1h':
      return count(12).map((step) => minutesAgo(step * 5));
    case '6h':
      return count(12).map((step) => minutesAgo(step * 30));
    case '12h':
      return count(12).map((step) => hoursAgo(step));
    case '24h':
      return count(24).map((step) => hoursAgo(step));
    case '7d':
      return count(7).map((step) => daysAgo(step));
    case '30d':
    case 'all':
      return count(30).map((step) => daysAgo(step));
  }
}

/**
 * Which stages a config would actually run. A stage is inert when the pipeline
 * is off, when its own switch is off, or — for the two that carry their own
 * detail — when that detail is set to nothing.
 */
function activeStages(config: TokenSaverConfig): readonly CompressionStageId[] {
  if (!config.enabled) return [];
  const ids: readonly CompressionStageId[] = ['tsc', 'dcp', 'rtk', 'caveman', 'cacheMarkers'];
  return ids.filter((id) => {
    if (!config.stages[id]) return false;
    if (id === 'caveman') return config.cavemanTier !== 'off';
    if (id === 'rtk') {
      const enabled = Object.entries(config.rtkFilters).filter(
        ([, on]) => on,
      ) as readonly [RtkFilterId, boolean][];
      return enabled.length > 0;
    }
    return true;
  });
}

export function buildTokenSaverSavings(
  rng: Rng,
  window: TimeWindow,
  config: TokenSaverConfig,
): TokenSaverSavings {
  const stages = activeStages(config);
  const requests = stages.length === 0 ? 0 : rng.int(1_400, 4_800);

  const perStage: TokenSaverStageSavings[] = stages.map((stageId) => {
    const bytesIn = STAGE_BYTES_IN[stageId] * requests;
    // A little per-run noise, so the bars are not perfectly proportional.
    const ratio = STAGE_RATIO[stageId] * rng.float(0.88, 1.12);
    const bytesOut = Math.round(bytesIn * (1 - ratio));
    return {
      stageId,
      bytesIn,
      bytesOut,
      tokensSaved: Math.max(0, Math.round((bytesIn - bytesOut) / BYTES_PER_TOKEN)),
    };
  });

  const tokensSaved = perStage.reduce((total, stage) => total + stage.tokensSaved, 0);
  const tokensIn = Math.max(
    tokensSaved + 1,
    Math.round((STAGE_BYTES_IN.cacheMarkers * requests) / BYTES_PER_TOKEN),
  );

  // The trend is the total spread over the points, with a weekly swell so the
  // line has a shape rather than being flat.
  const stamps = seriesStamps(window);
  const weights = stamps.map((_stamp, index) => 0.7 + 0.6 * Math.sin(index / 1.9) + rng.float(0, 0.25));
  const weightSum = weights.reduce((total, weight) => total + weight, 0);
  const series = stamps.map((date, index) => ({
    date,
    tokensSaved: Math.round((tokensSaved * (weights[index] ?? 0)) / weightSum),
  }));

  return {
    window,
    requestsProcessed: requests,
    tokensIn,
    tokensOut: tokensIn - tokensSaved,
    tokensSaved,
    ratio: tokensSaved / tokensIn,
    perStage,
    series,
  };
}
