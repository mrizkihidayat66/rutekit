import type {
  CanonicalMessage,
  ChatCompletionRequest,
  ContentBlock,
  TextBlock,
  ToolChoice,
  ToolDefinition,
  ToolUseBlock,
} from '@contracts';

import { imageBlockFromUrl, parseToolArguments } from '../blocks.ts';
import type { CanonicalRequest, ResponseFormat, Sampling } from '../canonical-request.ts';
import { extrasOf, stopList } from './shared.ts';

/**
 * `/v1/chat/completions` into the pivot.
 *
 * Two shape decisions belong to this surface. `developer` is the newer spelling
 * of `system`, and both are hoisted, because the pivot has one place for
 * standing instructions. And an assistant turn's `tool_calls` sit beside its
 * `content` rather than inside it, so they are appended after the content blocks
 * to keep the call ordered after whatever the model said before making it.
 */

type ChatMessageIn = ChatCompletionRequest['messages'][number];

/**
 * The keys this function reads. Anything else the surface allows — `n`,
 * `logit_bias`, `user` — is carried through in `extras` rather than dropped,
 * because the pivot is not the only place a parameter can be honoured.
 */
const CONSUMED = new Set([
  'model',
  'messages',
  'temperature',
  'top_p',
  'max_tokens',
  'stop',
  'seed',
  'stream',
  'presence_penalty',
  'frequency_penalty',
  'response_format',
  'tools',
  'tool_choice',
]);

function contentBlocksOf(content: ChatMessageIn['content']): ContentBlock[] {
  if (content == null) return [];
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];

  const blocks: ContentBlock[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text !== '') blocks.push({ type: 'text', text: part.text });
      continue;
    }
    const image = imageBlockFromUrl(part.image_url.url);
    if (image !== null) blocks.push(image);
  }
  return blocks;
}

function toolUseBlocksOf(calls: ChatMessageIn['tool_calls']): ToolUseBlock[] {
  if (calls === undefined) return [];
  return calls.map((call) => ({
    type: 'tool_use',
    id: call.id,
    name: call.function.name,
    input: parseToolArguments(call.function.arguments),
  }));
}

function toolsOf(tools: ChatCompletionRequest['tools']): ToolDefinition[] {
  if (tools === undefined) return [];
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? null,
    parameters: tool.function.parameters ?? {},
  }));
}

function toolChoiceOf(choice: ChatCompletionRequest['tool_choice']): ToolChoice | null {
  if (choice === undefined) return null;
  if (typeof choice === 'string') return choice;
  return { type: 'tool', name: choice.function.name };
}

function responseFormatOf(
  format: ChatCompletionRequest['response_format'],
): ResponseFormat | null {
  if (format === undefined) return null;
  return { type: format.type, jsonSchema: format.json_schema ?? null };
}

export function ingestChatCompletion(body: ChatCompletionRequest): CanonicalRequest {
  const system: TextBlock[] = [];
  const messages: CanonicalMessage[] = [];

  for (const message of body.messages) {
    if (message.role === 'system' || message.role === 'developer') {
      for (const block of contentBlocksOf(message.content)) {
        if (block.type === 'text') system.push(block);
      }
      continue;
    }

    messages.push({
      role: message.role,
      content: [...contentBlocksOf(message.content), ...toolUseBlocksOf(message.tool_calls)],
      name: message.name ?? null,
      toolCallId: message.tool_call_id ?? null,
    });
  }

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
    system,
    messages,
    sampling,
    tools: toolsOf(body.tools),
    toolChoice: toolChoiceOf(body.tool_choice),
    responseFormat: responseFormatOf(body.response_format),
    stream: body.stream ?? false,
    extras: extrasOf(body, CONSUMED),
  };
}
