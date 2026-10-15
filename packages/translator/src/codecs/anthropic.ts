import type {
  ApiError,
  CanonicalMessage,
  ContentBlock,
  ErrorKind,
  FinishReason,
  ImageBlock,
  Usage,
} from '@contracts';

import { asRecord, imageBlockOf, toolResultContentOf } from '../blocks.ts';
import type { CanonicalRequest } from '../canonical-request.ts';
import type { CanonicalResult } from '../canonical-result.ts';
import { arr, httpErrorKind, num, statusMessage, str, zeroUsage } from './shared.ts';
import type { CodecContext, EncodedRequest, ErrorInput } from './types.ts';

/**
 * The Anthropic wire family.
 *
 * This is the dialect the pivot's stream vocabulary was copied from, so the
 * decode direction is nearly an identity — which is exactly why the route sends a
 * Claude client straight to an Anthropic provider instead of through here: the one
 * thing the pivot cannot carry is a thinking block's `signature`, and a multi-turn
 * replay needs it byte for byte.
 *
 * The encode direction has one hard requirement the pivot does not: `max_tokens`
 * is mandatory. A caller who left it unset gets `DEFAULT_MAX_TOKENS` rather than a
 * 400 from the provider.
 */

const DEFAULT_PATH = '/messages';

/** Anthropic rejects a request without `max_tokens`; the pivot allows it unset. */
const DEFAULT_MAX_TOKENS = 4096;

function anthropicBlockOf(block: ContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.text,
        ...(block.signature !== null ? { signature: block.signature } : {}),
      };
    case 'image':
      return { type: 'image', source: anthropicSource(block) };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        is_error: block.isError,
        content: block.content.map(anthropicResultPart),
      };
  }
}

function anthropicSource(block: ImageBlock): Record<string, unknown> {
  if (block.url !== null) return { type: 'url', url: block.url };
  return { type: 'base64', media_type: block.mediaType, data: block.data };
}

function anthropicResultPart(block: ContentBlock): Record<string, unknown> {
  if (block.type === 'image') return { type: 'image', source: anthropicSource(block) };
  return { type: 'text', text: block.type === 'text' ? block.text : '' };
}

function messageOf(message: CanonicalMessage): Record<string, unknown> {
  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content.map(anthropicBlockOf),
  };
}

function toolChoiceOf(choice: CanonicalRequest['toolChoice']): Record<string, unknown> | null {
  if (choice === null) return null;
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  return { type: 'tool', name: choice.name };
}

export function encodeAnthropicRequest(request: CanonicalRequest): EncodedRequest {
  const body: Record<string, unknown> = {
    ...request.extras,
    model: request.model,
    max_tokens: request.sampling.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: request.messages.map(messageOf),
    stream: request.stream,
  };

  // Anthropic carries the system prompt at the top level, which is why the pivot
  // hoists it out of `messages` in the first place.
  if (request.system.length > 0) {
    body.system = request.system.map((block) => ({ type: 'text', text: block.text }));
  }

  const sampling = request.sampling;
  if (sampling.temperature !== null) body.temperature = sampling.temperature;
  if (sampling.topP !== null) body.top_p = sampling.topP;
  if (sampling.topK !== null) body.top_k = sampling.topK;
  if (sampling.stop.length > 0) body.stop_sequences = sampling.stop;
  // Anthropic has no `seed`, `presence_penalty` or `frequency_penalty`; those are
  // dropped rather than sent under a name the provider would reject.

  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description !== null ? { description: tool.description } : {}),
      input_schema: tool.parameters,
    }));
  }

  const choice = toolChoiceOf(request.toolChoice);
  if (choice !== null) body.tool_choice = choice;

  return { path: DEFAULT_PATH, body };
}

/**
 * This family's stop reasons, read as the pivot's.
 *
 * `pause_turn` is a server-tool pause rather than an answer, but the turn did
 * end and a client that treats it as `stop` can send it back; only an
 * unrecognised reason becomes `error`.
 */
export function anthropicFinishReason(value: unknown): FinishReason {
  switch (str(value) ?? '') {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'error';
  }
}

export function anthropicUsageOf(value: unknown): Usage {
  const record = asRecord(value);
  if (record === null) return zeroUsage();

  const inputTokens = num(record.input_tokens) ?? 0;
  const outputTokens = num(record.output_tokens) ?? 0;

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: num(record.cache_read_input_tokens) ?? 0,
    // Anthropic reports no separate reasoning count; thinking is billed as output.
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}

/** One content block of an Anthropic body, read as a pivot block. */
export function decodeAnthropicBlock(value: unknown): ContentBlock | null {
  const block = asRecord(value);
  if (block === null) return null;

  switch (str(block.type) ?? '') {
    case 'text':
      return { type: 'text', text: str(block.text) ?? '' };
    case 'thinking':
      return {
        type: 'thinking',
        text: str(block.thinking) ?? '',
        signature: str(block.signature) ?? null,
      };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: str(block.id) ?? '',
        name: str(block.name) ?? '',
        input: asRecord(block.input) ?? {},
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: str(block.tool_use_id) ?? '',
        isError: block.is_error === true,
        content: toolResultContentOf(block.content),
      };
    case 'image':
      return imageBlockOf(block);
    default:
      // `redacted_thinking` and any future block kind have no pivot spelling; a
      // client that needs them is on the direct route, not through here.
      return null;
  }
}

export function decodeAnthropicResponse(body: unknown, context: CodecContext): CanonicalResult {
  const record = asRecord(body) ?? {};
  const blocks: ContentBlock[] = [];
  for (const block of arr(record.content)) {
    const decoded = decodeAnthropicBlock(block);
    if (decoded !== null) blocks.push(decoded);
  }

  return {
    id: str(record.id) ?? context.ids.message(),
    model: str(record.model) ?? context.model,
    // Anthropic reports no creation time, so the caller's clock supplies one.
    created: context.now(),
    message: { role: 'assistant', content: blocks, name: null, toolCallId: null },
    finishReason: anthropicFinishReason(record.stop_reason),
    usage: anthropicUsageOf(record.usage),
  };
}

/** The vendor's own error `type` strings, which are more precise than the status. */
const ANTHROPIC_KINDS: Readonly<Record<string, ErrorKind>> = {
  invalid_request_error: 'invalid_request',
  request_too_large: 'invalid_request',
  authentication_error: 'authentication',
  permission_error: 'permission',
  not_found_error: 'not_found',
  rate_limit_error: 'rate_limit',
  billing_error: 'quota_exhausted',
  overloaded_error: 'unavailable',
  api_error: 'upstream_error',
};

export function anthropicError(input: ErrorInput): ApiError {
  const record = asRecord(input.body);
  const error = asRecord(record?.error);
  const type = str(error?.type) ?? str(record?.type);
  const message = str(error?.message) ?? statusMessage(input.status);

  return {
    kind: ANTHROPIC_KINDS[type ?? ''] ?? httpErrorKind(input.status, null),
    message,
    provider: null,
    retryAfterSeconds: input.retryAfterSeconds,
    requestId: null,
  };
}
