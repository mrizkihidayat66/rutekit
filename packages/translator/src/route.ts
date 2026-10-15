import type { WireFamily } from '@contracts';

import type { ClientSurface } from './surface.ts';

/**
 * Whether a provider's own answer can go back untouched, or has to be pivoted.
 *
 * This decides the **answer** direction only. The request always pivots: the
 * Token Saver works on the canonical request, so a body forwarded verbatim is a
 * body rutekit cannot compress, and the two pairs below are the two commonest
 * ones in the world. What the pivot would otherwise cost on the way in — fields
 * the canonical shape has never heard of — is already paid for by `extras`,
 * which every codec spreads back into the body it builds.
 *
 * On the way out the loss is real, and it is why two pairs are exact — a client
 * speaking a dialect to a provider speaking that same dialect, where a re-render
 * would only throw away what the provider said:
 *
 *   - Claude clients to Anthropic providers, because a thinking block's
 *     `signature` has to survive a multi-turn replay byte for byte and the pivot
 *     has no event that carries one mid-stream.
 *   - OpenAI clients to OpenAI-family providers, because those clients send fields
 *     the pivot has never heard of and a provider that is the same API will
 *     understand all of them.
 *
 * Everything else pivots, including two pairs that look close and are not:
 * `/v1/completions` is the legacy shape, not the family's chat shape, and no
 * manifest names a path for it; `/v1/responses` is a different API from
 * `/v1/chat/completions` rather than a different spelling of it. `google` and
 * `custom` have no matching client surface at all.
 */
export type RouteDecision = 'direct' | 'pivot';

export function chooseRoute(surface: ClientSurface, family: WireFamily): RouteDecision {
  if (surface === 'chat-completions' && family === 'openai') return 'direct';
  if (surface === 'messages' && family === 'anthropic') return 'direct';
  return 'pivot';
}
