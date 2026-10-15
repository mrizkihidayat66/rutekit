import type {
  CanonicalMessage,
  ContentBlock,
  ResponsesRequest,
  TextBlock,
  ToolChoice,
  ToolDefinition,
} from '@contracts';

import { asRecord, contentBlockOf, parseToolArguments } from '../blocks.ts';
import type { CanonicalRequest, Sampling } from '../canonical-request.ts';
import { extrasOf, userMessage } from './shared.ts';

/**
 * `/v1/responses` into the pivot.
 *
 * The item list is where this surface differs most: a function call and its
 * output are *siblings* at the top level rather than blocks inside a turn, so
 * each one becomes its own canonical message. That is a rebuild rather than a
 * copy, and it is the reason this surface is the one most likely to need the
 * direct route.
 *
 * `previous_response_id` names state held by the provider that issued it, which
 * the pivot cannot resolve. It survives in `extras` so the dispatcher can see
 * it and refuse the pivot route rather than forwarding a reference to a provider
 * that never heard of it.
 */

type ResponsesItemIn = Exclude<ResponsesRequest['input'], string>[number];
type ResponsesMessageIn = Extract<ResponsesItemIn, { type: 'message' }>;

/**
 * The keys this function reads. `previous_response_id` and `store` are
 * deliberately absent: both name server-side state the pivot cannot resolve, so
 * they travel in `extras` where the dispatcher can see them and route directly
 * rather than forward a reference to a provider that never issued it.
 */
const CONSUMED = new Set([
  'model',
  'input',
  'instructions',
  'max_output_tokens',
  'temperature',
  'top_p',
  'stream',
  'tools',
  'tool_choice',
]);

function messageBlocksOf(content: ResponsesMessageIn['content']): ContentBlock[] {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];

  const blocks: ContentBlock[] = [];
  for (const part of content) {
    const block = contentBlockOf(part);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}

function reasoningTextOf(summary: unknown): string {
  if (!Array.isArray(summary)) return '';
  const parts: string[] = [];
  for (const part of summary) {
    const record = asRecord(part);
    if (record !== null && typeof record.text === 'string') parts.push(record.text);
  }
  return parts.join('\n');
}

function toolsOf(tools: ResponsesRequest['tools']): ToolDefinition[] {
  if (tools === undefined) return [];

  const definitions: ToolDefinition[] = [];
  for (const tool of tools) {
    if (typeof tool.name !== 'string') continue;
    definitions.push({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : null,
      parameters: asRecord(tool.parameters) ?? {},
    });
  }
  return definitions;
}

function toolChoiceOf(choice: unknown): ToolChoice | null {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;

  const record = asRecord(choice);
  if (record === null) return null;
  if ((record.type === 'function' || record.type === 'tool') && typeof record.name === 'string') {
    return { type: 'tool', name: record.name };
  }
  return null;
}

function appendItem(item: ResponsesItemIn, messages: CanonicalMessage[], system: TextBlock[]): void {
  switch (item.type) {
    case 'message': {
      const blocks = messageBlocksOf(item.content);
      if (item.role === 'system' || item.role === 'developer') {
        for (const block of blocks) {
          if (block.type === 'text') system.push(block);
        }
        return;
      }
      messages.push({ role: item.role, content: blocks, name: null, toolCallId: null });
      return;
    }
    case 'function_call':
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: item.call_id,
            name: item.name,
            input: parseToolArguments(item.arguments),
          },
        ],
        name: null,
        toolCallId: null,
      });
      return;
    case 'function_call_output':
      messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolUseId: item.call_id,
            isError: false,
            content: item.output === '' ? [] : [{ type: 'text', text: item.output }],
          },
        ],
        name: null,
        toolCallId: item.call_id,
      });
      return;
    case 'reasoning':
      messages.push({
        role: 'assistant',
        content: [{ type: 'thinking', text: reasoningTextOf(item.summary), signature: null }],
        name: null,
        toolCallId: null,
      });
      return;
  }
}

export function ingestResponses(body: ResponsesRequest): CanonicalRequest {
  const system: TextBlock[] = [];
  if (body.instructions !== undefined && body.instructions !== '') {
    system.push({ type: 'text', text: body.instructions });
  }

  const messages: CanonicalMessage[] = [];
  if (typeof body.input === 'string') {
    if (body.input !== '') messages.push(userMessage(body.input));
  } else {
    for (const item of body.input) appendItem(item, messages, system);
  }

  const sampling: Sampling = {
    temperature: body.temperature ?? null,
    topP: body.top_p ?? null,
    topK: null,
    maxTokens: body.max_output_tokens ?? null,
    stop: [],
    seed: null,
    presencePenalty: null,
    frequencyPenalty: null,
  };

  return {
    model: body.model,
    system,
    messages,
    sampling,
    tools: toolsOf(body.tools),
    toolChoice: toolChoiceOf(body.tool_choice),
    responseFormat: null,
    stream: body.stream ?? false,
    extras: extrasOf(body, CONSUMED),
  };
}
