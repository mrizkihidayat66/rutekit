import type { CanonicalMessage, CompletionRequest } from '@contracts';

import type { CanonicalRequest, Sampling } from '../canonical-request.ts';
import { extrasOf, stopList, userMessage } from './shared.ts';

/**
 * `/v1/completions` into the pivot.
 *
 * A bare `prompt` has no turns, so it becomes a single user message — which is
 * what a FIM client means by it. The one lossy step is an array prompt: the
 * legacy surface reads that as a *batch* of independent prompts, and the pivot
 * describes one conversation, so the elements are joined. A client relying on
 * the batch reading needs the direct route, and that is a routing decision the
 * translator should not be making silently.
 */

/**
 * The keys this function reads. `suffix` is the one that matters here: it is the
 * FIM continuation the client wants appended, and dropping it would answer with
 * the wrong text rather than an incomplete one.
 */
const CONSUMED = new Set([
  'model',
  'prompt',
  'temperature',
  'top_p',
  'max_tokens',
  'stop',
  'seed',
  'stream',
  'presence_penalty',
  'frequency_penalty',
]);

export function ingestCompletion(body: CompletionRequest): CanonicalRequest {
  const prompt = typeof body.prompt === 'string' ? body.prompt : body.prompt.join('\n');
  const messages: CanonicalMessage[] = prompt === '' ? [] : [userMessage(prompt)];

  const sampling: Sampling = {
    temperature: body.temperature ?? null,
    topP: body.top_p ?? null,
    topK: null,
    maxTokens: body.max_tokens ?? null,
    stop: stopList(body.stop),
    seed: body.seed ?? null,
    presencePenalty: body.presence_penalty ?? null,
    frequencyPenalty: body.frequency_penalty ?? null,
  };

  return {
    model: body.model,
    system: [],
    messages,
    sampling,
    tools: [],
    toolChoice: null,
    responseFormat: null,
    stream: body.stream ?? false,
    extras: extrasOf(body, CONSUMED),
  };
}
