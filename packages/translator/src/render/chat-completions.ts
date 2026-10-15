import { toOpenAiUsage } from '@contracts';
import type { ChatCompletionResponse, ContentBlock } from '@contracts';
import { sseComment, sseFrame } from '@shared';

import type { CanonicalResult } from '../canonical-result.ts';
import {
  openAiErrorBody,
  openAiFinish,
  textOf,
  thinkingOf,
  toolUsesOf,
  type StreamRenderer,
} from './shared.ts';

/**
 * The pivot back out to `/v1/chat/completions`.
 *
 * This is the surface every OpenAI-compatible client reads, so it is also the one
 * whose quirks are load-bearing: `content` is null rather than empty when a turn
 * is nothing but tool calls, and reasoning text rides in the non-standard
 * `reasoning_content` field that reasoning-model clients already look for.
 */

type ChatMessageOut = ChatCompletionResponse['choices'][number]['message'];

function messageOf(blocks: readonly ContentBlock[]): ChatMessageOut {
  const text = textOf(blocks);
  const reasoning = thinkingOf(blocks);
  const calls = toolUsesOf(blocks);

  const message: ChatMessageOut = {
    role: 'assistant',
    content: text === '' && calls.length > 0 ? null : text,
  };
  if (reasoning !== '') message.reasoning_content = reasoning;
  if (calls.length > 0) {
    message.tool_calls = calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.input) },
    }));
  }
  return message;
}

export function renderChatCompletion(result: CanonicalResult): ChatCompletionResponse {
  return {
    id: result.id,
    object: 'chat.completion',
    created: result.created,
    model: result.model,
    choices: [
      {
        index: 0,
        message: messageOf(result.message.content),
        finish_reason: openAiFinish(result.finishReason),
      },
    ],
    usage: toOpenAiUsage(result.usage),
  };
}

export function createChatCompletionStream(): StreamRenderer {
  let id = '';
  let model = '';
  let created = 0;
  /** Block index to position among the tool calls, which is what the wire wants. */
  const ordinalOf = new Map<number, number>();

  const frame = (choices: readonly unknown[], usage?: unknown): string => {
    const body: Record<string, unknown> = {
      id,
      object: 'chat.completion.chunk',
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
          return frame([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);

        case 'block_start': {
          if (event.block.type !== 'tool_use') return null;
          const position = ordinalOf.size;
          ordinalOf.set(event.index, position);
          return frame([
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: position,
                    id: event.block.id,
                    type: 'function',
                    function: { name: event.block.name, arguments: '' },
                  },
                ],
              },
              finish_reason: null,
            },
          ]);
        }

        case 'text_delta':
          return frame([{ index: 0, delta: { content: event.text }, finish_reason: null }]);

        case 'thinking_delta':
          return frame([{ index: 0, delta: { reasoning_content: event.text }, finish_reason: null }]);

        case 'input_json_delta': {
          const position = ordinalOf.get(event.index);
          if (position === undefined) return null;
          return frame([
            {
              index: 0,
              delta: { tool_calls: [{ index: position, function: { arguments: event.partialJson } }] },
              finish_reason: null,
            },
          ]);
        }

        case 'block_stop':
          return null;

        case 'finish':
          // Usage rides on the closing chunk instead of a chunk of its own.
          // OpenAI only sends the separate one when the client opted in with
          // `stream_options.include_usage`, and a chunk carrying no choices
          // crashes the clients that index into `choices[0]` without looking.
          return `${frame(
            [{ index: 0, delta: {}, finish_reason: openAiFinish(event.finishReason) }],
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
