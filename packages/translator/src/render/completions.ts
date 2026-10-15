import { toOpenAiUsage } from '@contracts';
import type { CompletionResponse } from '@contracts';
import { sseComment, sseFrame } from '@shared';

import type { CanonicalResult } from '../canonical-result.ts';
import { completionFinish, openAiErrorBody, textOf, type StreamRenderer } from './shared.ts';

/**
 * The pivot back out to `/v1/completions`.
 *
 * The legacy surface is flat text: no roles, no blocks, no tool calls. Only the
 * text blocks survive, which is the honest answer — a FIM client asking for a
 * continuation has no way to express a tool call, so inventing one would produce
 * output it cannot parse.
 */

export function renderCompletion(result: CanonicalResult): CompletionResponse {
  return {
    id: result.id,
    object: 'text_completion',
    created: result.created,
    model: result.model,
    choices: [
      {
        index: 0,
        text: textOf(result.message.content),
        finish_reason: completionFinish(result.finishReason),
      },
    ],
    usage: toOpenAiUsage(result.usage),
  };
}

export function createCompletionStream(): StreamRenderer {
  let id = '';
  let model = '';
  let created = 0;

  const frame = (choices: readonly unknown[], usage?: unknown): string => {
    const body: Record<string, unknown> = {
      id,
      object: 'text_completion',
      created,
      model,
      choices,
    };
    if (usage !== undefined) body.usage = usage;
    return sseFrame({ data: JSON.stringify(body) });
  };

  return {
    render(event) {
      switch (event.type) {
        case 'start':
          id = event.id;
          model = event.model;
          created = event.created;
          return frame([{ index: 0, text: '', finish_reason: null }]);

        case 'text_delta':
          return frame([{ index: 0, text: event.text, finish_reason: null }]);

        // Thinking, tool calls and block boundaries have no counterpart here.
        case 'block_start':
        case 'thinking_delta':
        case 'input_json_delta':
        case 'block_stop':
          return null;

        case 'finish':
          return `${frame(
            [{ index: 0, text: '', finish_reason: completionFinish(event.finishReason) }],
            toOpenAiUsage(event.usage),
          )}${sseFrame({ data: '[DONE]' })}`;

        case 'error':
          return `${sseFrame({ data: JSON.stringify(openAiErrorBody(event.error)) })}${sseFrame({ data: '[DONE]' })}`;

        case 'ping':
          return sseComment('ping');
      }
    },
  };
}
