import type { ApiError } from '@contracts';

import type { CanonicalResult } from '../canonical-result.ts';
import type { ClientSurface } from '../surface.ts';
import { renderChatCompletion, createChatCompletionStream } from './chat-completions.ts';
import { renderCompletion, createCompletionStream } from './completions.ts';
import { renderMessages, createMessagesStream } from './messages.ts';
import { renderResponse, createResponsesStream } from './responses.ts';
import { anthropicErrorBody, openAiErrorBody, type StreamRenderer } from './shared.ts';

export { createChatCompletionStream, renderChatCompletion } from './chat-completions.ts';
export { createCompletionStream, renderCompletion } from './completions.ts';
export { createMessagesStream, renderMessages } from './messages.ts';
export { createResponsesStream, renderResponse } from './responses.ts';
export { createUiMessageStream } from './ui-message.ts';
export type { UiMessageMetadata, UiMessageRenderer, UiStreamOptions } from './ui-message.ts';
export * from './shared.ts';

/**
 * The result for a surface, ready to serialise.
 *
 * The switch is exhaustive over `ClientSurface`, so adding a surface is a type
 * error here until it is rendered — the same guarantee `ingestRequest` gives on
 * the way in.
 */
export function renderResult(surface: ClientSurface, result: CanonicalResult): unknown {
  switch (surface) {
    case 'chat-completions':
      return renderChatCompletion(result);
    case 'messages':
      return renderMessages(result);
    case 'responses':
      return renderResponse(result);
    case 'completions':
      return renderCompletion(result);
  }
}

/** A stateful encoder: `start` teaches it the id and model the later frames carry. */
export function createStreamRenderer(surface: ClientSurface): StreamRenderer {
  switch (surface) {
    case 'chat-completions':
      return createChatCompletionStream();
    case 'messages':
      return createMessagesStream();
    case 'responses':
      return createResponsesStream();
    case 'completions':
      return createCompletionStream();
  }
}

/**
 * The error envelope for a surface.
 *
 * Anthropic wraps errors in a `type: 'error'` object; the other three share the
 * OpenAI envelope. Three of four sharing one shape is why this is a small function
 * and not four files.
 */
export function renderError(surface: ClientSurface, error: ApiError): unknown {
  switch (surface) {
    case 'messages':
      return anthropicErrorBody(error);
    case 'chat-completions':
    case 'responses':
    case 'completions':
      return openAiErrorBody(error);
  }
}
