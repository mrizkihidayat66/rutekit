import type { CompressionStageId, TokenSaverConfig } from '@contracts';
import type { CanonicalRequest } from '@translator';

import { requestBytes, tokensSaved } from './bytes.ts';
import { cacheMarkersStage } from './cache-markers.ts';
import { cavemanStage } from './caveman.ts';
import { activeStages } from './config.ts';
import { dcpStage } from './dcp.ts';
import { rtkStage } from './rtk.ts';
import { tscStage } from './tsc.ts';
import type {
  CacheBoundary,
  CompressionStage,
  PipelineResult,
  StageContext,
  StageOutcome,
  StageReport,
} from './types.ts';

const STAGES: Readonly<Record<CompressionStageId, CompressionStage>> = {
  tsc: tscStage,
  dcp: dcpStage,
  rtk: rtkStage,
  caveman: cavemanStage,
  cacheMarkers: cacheMarkersStage,
};

export interface GuardedStage {
  readonly outcome: StageOutcome | null;
  readonly failed: boolean;
}

/**
 * The fail-open guard, applied to one stage.
 *
 * Exposed rather than inlined so the contract can be exercised with a stage that
 * throws on purpose — the one case the shipped stages are written never to
 * produce, and therefore the one that would otherwise go untested.
 */
export function runStage(
  stage: CompressionStage,
  request: CanonicalRequest,
  context: StageContext,
): GuardedStage {
  try {
    return { outcome: stage.apply(request, context), failed: false };
  } catch {
    // Fail-open (CONTRIBUTING §5.5): an optimisation must never fail a turn, so
    // a stage that threw is treated exactly as one that changed nothing.
    return { outcome: null, failed: true };
  }
}

function applyPipeline(request: CanonicalRequest, config: TokenSaverConfig): PipelineResult {
  const context: StageContext = { rtkFilters: config.rtkFilters, cavemanTier: config.cavemanTier };
  const stages: StageReport[] = [];
  const markers: CacheBoundary[] = [];
  let current = request;

  for (const id of activeStages(config)) {
    const before = current;
    const bytesIn = requestBytes(before);
    const { outcome, failed } = runStage(STAGES[id], before, context);

    if (outcome === null) {
      stages.push({ stageId: id, bytesIn, bytesOut: bytesIn, tokensSaved: 0, failed });
      continue;
    }

    current = outcome.request;
    if (outcome.markers !== undefined) markers.push(...outcome.markers);

    const bytesOut = requestBytes(current);
    stages.push({
      stageId: id,
      bytesIn,
      bytesOut,
      tokensSaved: tokensSaved(bytesIn, bytesOut),
      failed,
    });
  }

  return { request: current, stages, markers };
}

/**
 * Run the enabled stages over a request, in order, and report what each removed.
 *
 * The guarantee this function makes is the one the fail-open rule asks for: it
 * returns a usable request or it returns the original — it never throws, and it
 * never returns a half-compressed request from a stage that failed partway. Each
 * stage is guarded individually so one failure does not cost the stages after it,
 * and the whole run is guarded again because the rule is unconditional.
 */
export function runPipeline(request: CanonicalRequest, config: TokenSaverConfig): PipelineResult {
  try {
    return applyPipeline(request, config);
  } catch {
    return { request, stages: [], markers: [] };
  }
}
