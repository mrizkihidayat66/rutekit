import type {
  CanonicalMessage,
  ContentBlock,
  MessagesRequest,
  TextBlock,
  ToolChoice,
  ToolDefinition,
} from '@contracts';

import { asRecord, imageBlockOf, toolResultContentOf } from '../blocks.ts';
import type { CanonicalRequest, Sampling } from '../canonical-request.ts';
import { extrasOf, stopList } from './shared.ts';

/**
 * `/v1/messages` into the pivot.
 *
 * This surface keeps its own block layout rather than being flattened: a
 * `tool_result` stays inside the user turn that carried it, exactly where
 * Anthropic put it, because the ordering of a tool result against the turn it
 * answers is something Claude clients depend on. Flattening it into a separate
 * `tool` turn here and rebuilding it on the way out would be two chances to get
 * the order wrong for no gain.
 */

type MessagesMessageIn = MessagesRequest['messages'][number];
type AnthropicBlockIn = Exclude<MessagesMessageIn['content'], string>[number];

/**
 * The keys this function reads. `metadata` and `thinking` are not among them —
 * the pivot has no place for an extended-thinking budget, and dropping it here
 * would silently answer with a plain completion when the client asked for a
 * reasoned one.
 */
const CONSUMED = new Set([
  'model',
  'messages',
  'system',
  'max_tokens',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'stream',
  'tools',
  'tool_choice',
]);

function blockOf(block: AnthropicBlockIn): ContentBlock | null {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
      return imageBlockOf(block);
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: block.tool_use_id,
        isError: block.is_error ?? false,
        content: toolResultContentOf(block.content),
      };
    case 'thinking':
      return { type: 'thinking', text: block.thinking, signature: block.signature ?? null };
  }
}

function contentBlocksOf(content: MessagesMessageIn['content']): ContentBlock[] {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];

  const blocks: ContentBlock[] = [];
  for (const block of content) {
    const mapped = blockOf(block);
    if (mapped !== null) blocks.push(mapped);
  }
  return blocks;
}

/** The top-level `system`, which the pivot keeps text-only. */
function systemBlocksOf(system: MessagesRequest['system']): TextBlock[] {
  if (system === undefined) return [];
  if (typeof system === 'string') return system === '' ? [] : [{ type: 'text', text: system }];

  const blocks: TextBlock[] = [];
  for (const block of system) {
    if (block.type === 'text') blocks.push({ type: 'text', text: block.text });
  }
  return blocks;
}

function toolsOf(tools: MessagesRequest['tools']): ToolDefinition[] {
  if (tools === undefined) return [];

  const definitions: ToolDefinition[] = [];
  for (const tool of tools) {
    if (typeof tool.name !== 'string') continue;
    definitions.push({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : null,
      parameters: asRecord(tool.input_schema) ?? {},
    });
  }
  return definitions;
}

/** `any` is Anthropic's spelling of "must call one", which the pivot calls `required`. */
function toolChoiceOf(choice: MessagesRequest['tool_choice']): ToolChoice | null {
  if (choice === undefined) return null;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool' && typeof choice.name === 'string') {
    return { type: 'tool', name: choice.name };
  }
  return null;
}

export function ingestMessages(body: MessagesRequest): CanonicalRequest {
  const sampling: Sampling = {
    temperature: body.temperature ?? null,
    topP: body.top_p ?? null,
    topK: body.top_k ?? null,
    maxTokens: body.max_tokens,
    stop: stopList(body.stop_sequences),
    seed: null,
    presencePenalty: null,
    frequencyPenalty: null,
  };

  const messages: CanonicalMessage[] = body.messages.map((message) => ({
    role: message.role,
    content: contentBlocksOf(message.content),
    name: null,
    toolCallId: null,
  }));

  return {
    model: body.model,
    system: systemBlocksOf(body.system),
    messages,
    sampling,
    tools: toolsOf(body.tools),
    toolChoice: toolChoiceOf(body.tool_choice),
    responseFormat: null,
    stream: body.stream ?? false,
    extras: extrasOf(body, CONSUMED),
  };
}
