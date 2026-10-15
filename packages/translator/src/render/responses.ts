import { toOpenAiUsage } from '@contracts';
import type { ContentBlock, OpenAiUsage, ResponsesOutputItem, ResponsesResponse } from '@contracts';
import { sseFrame } from '@shared';

import type { CanonicalResult } from '../canonical-result.ts';
import { openAiErrorBody, textOf, type StreamRenderer } from './shared.ts';

/**
 * The pivot back out to `/v1/responses`.
 *
 * This surface is item-shaped where the others are turn-shaped: reasoning, text
 * and each function call are siblings in one flat `output` list rather than
 * blocks inside a message. The renderer rebuilds that list, and the stream keeps
 * the items in step by accumulating each one as its deltas arrive — the closing
 * `response.completed` has to carry the whole thing, and a delta that was
 * forwarded but not kept is a delta the final response is missing.
 */

type PendingKind = 'text' | 'thinking' | 'tool_use';

interface Pending {
  readonly kind: PendingKind;
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  text: string;
  args: string;
}

function itemId(kind: PendingKind, prefix: string, index: number): string {
  const suffix = kind === 'text' ? 'msg' : kind === 'thinking' ? 'rs' : 'fc';
  return `${prefix}-${suffix}-${index}`;
}

function itemOf(pending: Pending): ResponsesOutputItem {
  switch (pending.kind) {
    case 'text':
      return {
        type: 'message',
        id: pending.id,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: pending.text, annotations: [] }],
      };
    case 'thinking':
      return {
        type: 'reasoning',
        id: pending.id,
        summary: [{ type: 'summary_text', text: pending.text }],
        status: 'completed',
      };
    case 'tool_use':
      return {
        type: 'function_call',
        id: pending.id,
        call_id: pending.callId,
        name: pending.name,
        arguments: pending.args,
        status: 'completed',
      };
  }
}

function outputOf(result: CanonicalResult): ResponsesOutputItem[] {
  const items: ResponsesOutputItem[] = [];
  const content = result.message.content;

  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    if (block === undefined) continue;

    if (block.type === 'text' && block.text !== '') {
      items.push(
        itemOf({ kind: 'text', id: itemId('text', result.id, index), callId: '', name: '', text: block.text, args: '' }),
      );
    } else if (block.type === 'thinking' && block.text !== '') {
      items.push(
        itemOf({ kind: 'thinking', id: itemId('thinking', result.id, index), callId: '', name: '', text: block.text, args: '' }),
      );
    } else if (block.type === 'tool_use') {
      items.push(
        itemOf({
          kind: 'tool_use',
          id: itemId('tool_use', result.id, index),
          callId: block.id,
          name: block.name,
          text: '',
          args: JSON.stringify(block.input),
        }),
      );
    }
    // An image or a tool result has no item in this surface's vocabulary.
  }
  return items;
}

export function renderResponse(result: CanonicalResult): ResponsesResponse {
  const output = outputOf(result);
  return {
    id: result.id,
    object: 'response',
    created_at: result.created,
    status: 'completed',
    model: result.model,
    output,
    output_text: textOf(result.message.content),
    usage: toOpenAiUsage(result.usage),
    previous_response_id: null,
  };
}

function envelope(
  id: string,
  model: string,
  created: number,
  status: 'in_progress' | 'completed',
  output: readonly ResponsesOutputItem[],
  usage: OpenAiUsage | null,
): Record<string, unknown> {
  let text = '';
  for (const item of output) {
    if (item.type === 'message') {
      for (const part of item.content) {
        if (part.type === 'output_text' && typeof part.text === 'string') text += part.text;
      }
    }
  }
  return {
    id,
    object: 'response',
    created_at: created,
    status,
    model,
    output,
    output_text: text,
    usage,
    previous_response_id: null,
  };
}

function addedItem(pending: Pending): Record<string, unknown> {
  switch (pending.kind) {
    case 'text':
      return { type: 'message', id: pending.id, role: 'assistant', status: 'in_progress', content: [] };
    case 'thinking':
      return { type: 'reasoning', id: pending.id, summary: [], status: 'in_progress' };
    case 'tool_use':
      return {
        type: 'function_call',
        id: pending.id,
        call_id: pending.callId,
        name: pending.name,
        arguments: '',
        status: 'in_progress',
      };
  }
}

export function createResponsesStream(): StreamRenderer {
  let id = '';
  let model = '';
  let created = 0;
  let sequence = 0;
  const pending = new Map<number, Pending>();

  const frame = (event: string, body: Record<string, unknown>): string => {
    sequence += 1;
    return sseFrame({ event, data: JSON.stringify({ ...body, sequence_number: sequence }) });
  };

  return {
    render(event) {
      switch (event.type) {
        case 'start':
          id = event.id;
          model = event.model;
          created = event.created;
          return frame('response.created', {
            type: 'response.created',
            response: envelope(id, model, created, 'in_progress', [], null),
          });

        case 'block_start': {
          const block: ContentBlock = event.block;
          if (block.type === 'text' || block.type === 'thinking' || block.type === 'tool_use') {
            const kind: PendingKind = block.type;
            const entry: Pending = {
              kind,
              id: itemId(kind, id, event.index),
              callId: block.type === 'tool_use' ? block.id : '',
              name: block.type === 'tool_use' ? block.name : '',
              text: '',
              args: '',
            };
            pending.set(event.index, entry);

            const opened = frame('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: event.index,
              item: addedItem(entry),
            });
            if (kind !== 'text') return opened;
            return `${opened}${frame('response.content_part.added', {
              type: 'response.content_part.added',
              item_id: entry.id,
              output_index: event.index,
              content_index: 0,
              part: { type: 'output_text', text: '', annotations: [] },
            })}`;
          }
          return null;
        }

        case 'text_delta': {
          const entry = pending.get(event.index);
          if (entry === undefined) return null;
          entry.text += event.text;
          return frame('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: entry.id,
            output_index: event.index,
            content_index: 0,
            delta: event.text,
          });
        }

        case 'thinking_delta': {
          const entry = pending.get(event.index);
          if (entry === undefined) return null;
          entry.text += event.text;
          return frame('response.reasoning_summary_text.delta', {
            type: 'response.reasoning_summary_text.delta',
            item_id: entry.id,
            output_index: event.index,
            summary_index: 0,
            delta: event.text,
          });
        }

        case 'input_json_delta': {
          const entry = pending.get(event.index);
          if (entry === undefined) return null;
          entry.args += event.partialJson;
          return frame('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: entry.id,
            output_index: event.index,
            delta: event.partialJson,
          });
        }

        case 'block_stop': {
          const entry = pending.get(event.index);
          if (entry === undefined) return null;
          return frame('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: event.index,
            item: itemOf(entry),
          });
        }

        case 'finish': {
          const output: ResponsesOutputItem[] = [];
          const indexes = [...pending.keys()].sort((a, b) => a - b);
          for (const index of indexes) {
            const entry = pending.get(index);
            if (entry !== undefined) output.push(itemOf(entry));
          }
          return `${frame('response.completed', {
            type: 'response.completed',
            response: envelope(id, model, created, 'completed', output, toOpenAiUsage(event.usage)),
          })}${sseFrame({ data: '[DONE]' })}`;
        }

        case 'error':
          return `${frame('error', { type: 'error', ...openAiErrorBody(event.error) })}${sseFrame({ data: '[DONE]' })}`;

        case 'ping':
          return null;
      }
    },
  };
}
