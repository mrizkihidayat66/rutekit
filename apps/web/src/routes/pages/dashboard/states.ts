import type { EndpointStatus, HealthState } from '@contracts';

import type { Tone } from '@web/components/patterns/tone.ts';

/**
 * The Dashboard's shared readings.
 *
 * A state is a fact from the API; a tone is how it is coloured, and keeping the
 * mapping in one file means every card resolves `degraded` to the same amber.
 * These sit beside the page rather than in `components/` because only this page
 * reads them (CONTRIBUTING §5), and in a file of their own rather than inside a
 * component file because exporting a component and a helper together breaks
 * fast refresh.
 */

export const HEALTH_TONE: Record<HealthState, Tone> = {
  healthy: 'success',
  degraded: 'warning',
  down: 'danger',
  unknown: 'neutral',
};

/** The one place the console decides when a gauge stops being green. */
export function usageTone(ratio: number): Tone {
  if (ratio >= 0.9) return 'danger';
  if (ratio >= 0.75) return 'warning';
  return 'success';
}

/**
 * Mean latency across the endpoints that are actually serving. A disabled
 * surface has no measurement (`avgLatencyMs` is null) and must not drag the
 * average toward zero, which is why it is filtered out rather than treated as 0.
 */
export function averageLatency(endpoints: readonly EndpointStatus[]): number | null {
  const measured = endpoints
    .filter((entry) => entry.enabled && entry.avgLatencyMs !== null)
    .map((entry) => entry.avgLatencyMs ?? 0);
  if (measured.length === 0) return null;
  return measured.reduce((total, value) => total + value, 0) / measured.length;
}
