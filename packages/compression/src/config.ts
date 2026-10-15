import {
  COMPRESSION_STAGE_IDS,
  RTK_FILTER_IDS,
  type CompressionStageId,
  type TokenSaverConfig,
} from '@contracts';

/**
 * Which stages actually run, read from the operator's configuration.
 *
 * Two stages are inert unless their detail is set as well: RTK with no filter
 * turned on has nothing to apply, and Caveman at tier `off` is the operator
 * saying they do not want their instructions rewritten. Reporting those as
 * "active" would show savings that never happened.
 *
 * The master switch is checked first, so a disabled pipeline is inert regardless
 * of how the per-stage flags were left.
 */
export function stageEnabled(config: TokenSaverConfig, id: CompressionStageId): boolean {
  if (!config.enabled) return false;
  if (config.stages[id] !== true) return false;
  if (id === 'caveman') return config.cavemanTier !== 'off';
  if (id === 'rtk') return RTK_FILTER_IDS.some((filter) => config.rtkFilters[filter] === true);
  return true;
}

/** The enabled stages, in the pipeline's order (which is the order the ids are declared in). */
export function activeStages(config: TokenSaverConfig): CompressionStageId[] {
  return COMPRESSION_STAGE_IDS.filter((id) => stageEnabled(config, id));
}
