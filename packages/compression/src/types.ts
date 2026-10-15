import type { CavemanTier, CompressionNature, CompressionStageId, RtkFilterId } from '@contracts';
import type { CanonicalRequest } from '@translator';

/**
 * The shape every compression stage is written against.
 *
 * A stage reads the pivot request and returns an outcome, or `null` when it had
 * nothing to change. `null` rather than the input is deliberate: it is the same
 * value the fail-open guard produces, so the pipeline cannot tell a stage that
 * chose not to act from one that threw — and does not need to. Either way the
 * previous request is what continues.
 *
 * `markers` exists for the one stage whose product is not a smaller request but a
 * *marked* one. The pivot has no field for an ephemeral cache boundary — `extras`
 * is spread straight onto the wire, so a marker there would reach a provider as an
 * unknown top-level key — so the boundary is reported alongside the request and
 * the codec that understands caching consumes it.
 */
export interface CacheBoundary {
  readonly target: 'system' | 'lastMessage';
  readonly index: number;
}

export interface StageOutcome {
  readonly request: CanonicalRequest;
  readonly markers?: readonly CacheBoundary[];
}

export interface StageContext {
  readonly rtkFilters: Readonly<Record<RtkFilterId, boolean>>;
  readonly cavemanTier: CavemanTier;
}

export interface CompressionStage {
  readonly id: CompressionStageId;
  /** Whether the stage can be reversed by the model, or only shapes the request. */
  readonly nature: CompressionNature;
  apply(request: CanonicalRequest, context: StageContext): StageOutcome | null;
}

/** One stage's measured effect, in the contract's own savings vocabulary. */
export interface StageReport {
  readonly stageId: CompressionStageId;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly tokensSaved: number;
  /** True when the stage threw and its input was kept verbatim. */
  readonly failed: boolean;
}

export interface PipelineResult {
  readonly request: CanonicalRequest;
  readonly stages: readonly StageReport[];
  readonly markers: readonly CacheBoundary[];
}
