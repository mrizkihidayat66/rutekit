import type {
  ApiError,
  CanonicalMessage,
  ContentBlock,
  FinishReason,
  ImageBlock,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from '@contracts';

import { asRecord, parseToolArguments } from '../blocks.ts';
import type { CanonicalRequest } from '../canonical-request.ts';
import type { CanonicalResult } from '../canonical-result.ts';
import { arr, httpErrorKind, joinText, num, statusMessage, str, zeroUsage } from './shared.ts';
import type { CodecContext, EncodedRequest, ErrorInput } from './types.ts';

/**
 * The OpenAI wire family — the one every "openai-compatible" provider implements.
 *
 * It is also the family the pivot was modelled on, which makes this codec the
 * least surprising of the three and hides the one thing worth knowing: the
 * request shape here is `/v1/chat/completions`, not the family's whole surface.
 * `/v1/responses` is a different API, which is why a client on that surface
 * pivots even when the provider is this family.
 */

const DEFAULT_PATH = '/chat/completions';

/** A remote URL stays a reference; inline bytes are rebuilt into a data URL. */
function imageUrl(block: ImageBlock): string {
  if (block.url !== null) return block.url;
  return `data:${block.mediaType};base64,${block.data}`;
}

/**
 * A turn's content, as either a string or a part list.
 *
 * The string form is what a plain text turn gets, because some providers still
 * reject the array form for text-only input and none reject the string. The array
 * form appears only when there is an image, since that is the only thing the
 * string form cannot carry.
 */
function contentOf(blocks: readonly ContentBlock[]): string | unknown[] | null {
  const parts: unknown[] = [];
  let text = '';
  let hasImage = false;

  for (const block of blocks) {
    if (block.type === 'text') {
      text += block.text;
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      hasImage = true;
      parts.push({ type: 'image_url', image_url: { url: imageUrl(block) } });
    }
  }

  if (hasImage) return parts;
  return text === '' ? null : text;
}

function messageOf(message: CanonicalMessage): Record<string, unknown> {
  const calls = message.content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
  const results = message.content.filter(
    (block): block is ToolResultBlock => block.type === 'tool_result',
  );

  // A tool result is its own turn in this dialect, whatever role the pivot gave
  // it, because that is where the client's own SDK will look for it.
  const result = results[0];
  if (message.role === 'tool' || result !== undefined) {
    return {
      role: 'tool',
      tool_call_id: result?.toolUseId ?? message.toolCallId ?? '',
      content: result === undefined ? '' : joinText(result.content),
    };
  }

  const body: Record<string, unknown> = {
    role: message.role,
    // A turn that is nothing but tool calls carries null rather than an empty
    // string — the spelling the SDKs emit, and therefore the one they read.
    // `contentOf` already leaves it null when there is no text and no image.
    content: contentOf(message.content),
  };

  if (calls.length > 0) {
    body.tool_calls = calls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.input) },
    }));
  }
  if (message.name !== null) body.name = message.name;

  return body;
}

function toolChoiceOf(choice: CanonicalRequest['toolChoice']): unknown {
  if (choice === null) return undefined;
  if (typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
}

export function encodeOpenAiRequest(request: CanonicalRequest): EncodedRequest {
  const body: Record<string, unknown> = {
    // A client's unmodelled fields go first so that anything the pivot does
    // model wins: the pivot is authoritative for what it knows, and everything
    // else is a parameter rutekit has not learned rather than a correction.
    ...request.extras,
    model: request.model,
    messages: [
      ...(request.system.length > 0 ? [{ role: 'system', content: joinText(request.system) }] : []),
      ...request.messages.map(messageOf),
    ],
    stream: request.stream,
  };

  // Usage is what makes quota accounting work, and this family volunteers none
  // mid-stream unless the caller opts in. The pivot has no field for the opt-in,
  // so it is added here rather than lost; a client that set its own keeps it,
  // because `extras` was spread first.
  if (request.stream && body.stream_options === undefined) {
    body.stream_options = { include_usage: true };
  }

  const sampling = request.sampling;
  if (sampling.temperature !== null) body.temperature = sampling.temperature;
  if (sampling.topP !== null) body.top_p = sampling.topP;
  if (sampling.maxTokens !== null) body.max_tokens = sampling.maxTokens;
  if (sampling.stop.length > 0) body.stop = sampling.stop;
  if (sampling.seed !== null) body.seed = sampling.seed;
  if (sampling.presencePenalty !== null) body.presence_penalty = sampling.presencePenalty;
  if (sampling.frequencyPenalty !== null) body.frequency_penalty = sampling.frequencyPenalty;
  // `top_k` has no spelling in this family, so it is dropped rather than sent
  // under a name a provider would either ignore or reject.

  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description !== null ? { description: tool.description } : {}),
        parameters: tool.parameters,
      },
    }));
  }

  const choice = toolChoiceOf(request.toolChoice);
  if (choice !== undefined) body.tool_choice = choice;

  if (request.responseFormat !== null) {
    const format = request.responseFormat;
    body.response_format =
      format.type === 'json_schema'
        ? { type: 'json_schema', json_schema: format.jsonSchema ?? {} }
        : { type: format.type };
  }

  return { path: DEFAULT_PATH, body };
}

/**
 * This family's finish reasons, read as the pivot's.
 *
 * Anything unrecognised — including a missing one on a completed response — is
 * `error`. Calling it `stop` would be the one wrong answer: it says the model
 * chose to finish, and every renderer then tells the client the same thing.
 */
export function openAiFinishReason(value: string | undefined): FinishReason {
  switch (value ?? '') {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call': // the pre-2023 spelling, which a few providers still send
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'error';
  }
}

export function openAiUsage(value: unknown): Usage {
  const record = asRecord(value);
  if (record === null) return zeroUsage();

  const inputTokens = num(record.prompt_tokens) ?? 0;
  const outputTokens = num(record.completion_tokens) ?? 0;
  const cached = num(asRecord(record.prompt_tokens_details)?.cached_tokens) ?? 0;
  const reasoning = num(asRecord(record.completion_tokens_details)?.reasoning_tokens) ?? 0;

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: cached,
    reasoningTokens: reasoning,
    totalTokens: num(record.total_tokens) ?? inputTokens + outputTokens,
  };
}

export function decodeOpenAiResponse(body: unknown, context: CodecContext): CanonicalResult {
  const record = asRecord(body) ?? {};
  const choice = asRecord(arr(record.choices)[0]) ?? {};
  const message = asRecord(choice.message) ?? {};
  const blocks: ContentBlock[] = [];

  const reasoning = str(message.reasoning_content);
  if (reasoning !== undefined && reasoning !== '') {
    blocks.push({ type: 'thinking', text: reasoning, signature: null });
  }

  const content = message.content;
  if (typeof content === 'string' && content !== '') blocks.push({ type: 'text', text: content });

  for (const call of arr(message.tool_calls)) {
    const callRecord = asRecord(call) ?? {};
    const fn = asRecord(callRecord.function) ?? {};
    blocks.push({
      type: 'tool_use',
      id: str(callRecord.id) ?? context.ids.toolCall(),
      name: str(fn.name) ?? '',
      input: parseToolArguments(str(fn.arguments) ?? ''),
    });
  }

  return {
    id: str(record.id) ?? context.ids.chatCompletion(),
    model: str(record.model) ?? context.model,
    created: num(record.created) ?? context.now(),
    message: { role: 'assistant', content: blocks, name: null, toolCallId: null },
    finishReason: openAiFinishReason(str(choice.finish_reason)),
    usage: openAiUsage(record.usage),
  };
}

export function openAiError(input: ErrorInput): ApiError {
  const record = asRecord(input.body);
  const error = asRecord(record?.error);
  const code = str(error?.code) ?? str(error?.type) ?? null;
  const message =
    str(error?.message) ?? str(record?.message) ?? str(record?.error) ?? statusMessage(input.status);

  return {
    kind: httpErrorKind(input.status, code),
    message,
    provider: null,
    retryAfterSeconds: input.retryAfterSeconds,
    requestId: str(record?.request_id) ?? null,
  };
}
