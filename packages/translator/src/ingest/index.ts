import {
  chatCompletionRequestSchema,
  completionRequestSchema,
  messagesRequestSchema,
  responsesRequestSchema,
} from '@contracts';

import type { CanonicalRequest } from '../canonical-request.ts';
import type { ClientSurface } from '../surface.ts';
import { ingestChatCompletion } from './chat-completions.ts';
import { ingestCompletion } from './completions.ts';
import { ingestMessages } from './messages.ts';
import { ingestResponses } from './responses.ts';

export { ingestChatCompletion } from './chat-completions.ts';
export { ingestCompletion } from './completions.ts';
export { ingestMessages } from './messages.ts';
export { ingestResponses } from './responses.ts';

/**
 * The body for a surface, validated and pivoted.
 *
 * Validation happens here rather than being assumed, so the translator is
 * usable on its own: a caller that already parsed the body pays a second parse,
 * and a caller that did not gets the same rejection the ingress middleware would
 * have produced. The switch is exhaustive over `ClientSurface`, so adding a
 * surface is a type error until it is handled.
 */
export function ingestRequest(surface: ClientSurface, body: unknown): CanonicalRequest {
  switch (surface) {
    case 'chat-completions':
      return ingestChatCompletion(chatCompletionRequestSchema.parse(body));
    case 'messages':
      return ingestMessages(messagesRequestSchema.parse(body));
    case 'responses':
      return ingestResponses(responsesRequestSchema.parse(body));
    case 'completions':
      return ingestCompletion(completionRequestSchema.parse(body));
  }
}
