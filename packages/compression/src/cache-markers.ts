import type { CanonicalRequest } from '@translator';

import type { CacheBoundary, CompressionStage, StageOutcome } from './types.ts';

/**
 * Cache Markers — where a provider may put its cache boundary.
 *
 * The one stage that does not make the request smaller. It marks the two places
 * worth caching — the system prompt, which is identical across every call from
 * the same client, and the last turn, which is the prefix the next call will
 * repeat — so a provider with a prompt cache can bill the repeat at the cached
 * rate. The saving shows up on the *next* request, which is why the stage's own
 * byte delta is zero and its dashboard ratio is zero with it.
 *
 * The boundary is reported rather than written into the request. The pivot has no
 * field for one, and `extras` is spread straight onto the wire, so a marker there
 * would reach a provider as an unknown top-level key and be rejected. The codec
 * that understands caching reads `markers` and renders it in its own dialect; a
 * family with no cache concept ignores it, which is the correct no-op.
 */
export const cacheMarkersStage: CompressionStage = {
  id: 'cacheMarkers',
  nature: 'structural',

  apply(request: CanonicalRequest): StageOutcome | null {
    const markers: CacheBoundary[] = [];
    if (request.system.length > 0) markers.push({ target: 'system', index: 0 });
    if (request.messages.length > 0) {
      markers.push({ target: 'lastMessage', index: request.messages.length - 1 });
    }
    if (markers.length === 0) return null;
    return { request, markers };
  },
};
