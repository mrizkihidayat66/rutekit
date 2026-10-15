import type { ContentBlock, ImageBlock, MessagesResponse } from '@contracts';
import { sseFrame } from '@shared';

import type { CanonicalResult } from '../canonical-result.ts';
import {
  anthropicErrorBody,
  anthropicStop,
  anthropicUsage,
  type StreamRenderer,
} from './shared.ts';

/**
 * The pivot back out to `/v1/messages`.
 *
 * Two details are the whole reason this surface is not folded into the OpenAI one.
 * The stream opens with `message_start` before anything else, because a Claude
 * client allocates the message from it; and every frame carries an `event:` name,
 * so the renderer emits named frames rather than bare `data:` ones.
 */

type AnthropicBlockOut = MessagesResponse['content'][number];

function imageSource(block: ImageBlock): Record<string, unknown> {
  if (block.url !== null) return { type: 'url', url: block.url };
  return { type: 'base64', media_type: block.mediaType, data: block.data };
}

function blocksOf(blocks: readonly ContentBlock[]): AnthropicBlockOut[] {
  const out: AnthropicBlockOut[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text !== '') out.push({ type: 'text', text: block.text });
        break;
      case 'thinking': {
        const thinking: { type: 'thinking'; thinking: string; signature?: string } = {
          type: 'thinking',
          thinking: block.text,
        };
        if (block.signature !== null) thinking.signature = block.signature;
        out.push(thinking);
        break;
      }
      case 'tool_use':
        out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        break;
      case 'image':
        out.push({ type: 'image', source: imageSource(block) });
        break;
      // A tool result belongs to a user turn. One reaching an assistant turn
      // means a codec put it there by mistake, and emitting it would produce a
      // message the surface rejects outright.
      case 'tool_result':
        break;
    }
  }
  return out;
}

export function renderMessages(result: CanonicalResult): MessagesResponse {
  return {
    id: result.id,
    type: 'message',
    role: 'assistant',
    model: result.model,
    content: blocksOf(result.message.content),
    stop_reason: anthropicStop(result.finishReason),
    stop_sequence: null,
    usage: anthropicUsage(result.usage),
  };
}

/** The opening `content_block` for a block that is about to receive deltas. */
function blockStartOf(block: ContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: '' };
    case 'thinking':
      return { type: 'thinking', thinking: '', signature: '' };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: {} };
    case 'image':
      return { type: 'image', source: imageSource(block) };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        is_error: block.isError,
        content: [],
      };
  }
}

export function createMessagesStream(): StreamRenderer {
  let id = '';
  let model = '';
  let inputTokens = 0;

  const frame = (event: string, body: Record<string, unknown>): string =>
    sseFrame({ event, data: JSON.stringify(body) });

  return {
    render(event) {
      switch (event.type) {
        case 'start':
          id = event.id;
          model = event.model;
          inputTokens = event.usage?.inputTokens ?? 0;
          return frame('message_start', {
            type: 'message_start',
            message: {
              id,
              type: 'message',
              role: 'assistant',
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: inputTokens, output_tokens: 0 },
            },
          });

        case 'block_start':
          return frame('content_block_start', {
            type: 'content_block_start',
            index: event.index,
            content_block: blockStartOf(event.block),
          });

        case 'text_delta':
          return frame('content_block_delta', {
            type: 'content_block_delta',
            index: event.index,
            delta: { type: 'text_delta', text: event.text },
          });

        case 'thinking_delta':
          return frame('content_block_delta', {
            type: 'content_block_delta',
            index: event.index,
            delta: { type: 'thinking_delta', thinking: event.text },
          });

        case 'input_json_delta':
          return frame('content_block_delta', {
            type: 'content_block_delta',
            index: event.index,
            delta: { type: 'input_json_delta', partial_json: event.partialJson },
          });

        case 'block_stop':
          return frame('content_block_stop', { type: 'content_block_stop', index: event.index });

        case 'finish':
          return `${frame('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: anthropicStop(event.finishReason), stop_sequence: null },
            usage: { output_tokens: event.usage.outputTokens },
          })}${frame('message_stop', { type: 'message_stop' })}`;

        case 'error':
          return frame('error', anthropicErrorBody(event.error));

        case 'ping':
          return frame('ping', { type: 'ping' });
      }
    },
  };
}
