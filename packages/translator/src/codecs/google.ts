import type { ApiError, CanonicalMessage, ContentBlock, FinishReason, Usage } from '@contracts';

import { asRecord } from '../blocks.ts';
import type { CanonicalRequest } from '../canonical-request.ts';
import type { CanonicalResult } from '../canonical-result.ts';
import { arr, httpErrorKind, joinText, num, statusMessage, str, zeroUsage } from './shared.ts';
import type { CodecContext, EncodedRequest, ErrorInput } from './types.ts';

/**
 * The Google wire family (`generativelanguage.googleapis.com`).
 *
 * Two things set it apart from the other two. The model is part of the path
 * rather than the body, so the path is built per request; and a turn is a list of
 * typed `parts` rather than a string, which is why the pivot's blocks survive here
 * better than they do on the OpenAI side.
 *
 * Google reports neither an id nor a creation time, so `decodeResponse` synthesises
 * both from the caller's clock and id factory.
 */

function modelPath(model: string): string {
  return model.startsWith('models/') ? model : `models/${model}`;
}

function googlePath(model: string, stream: boolean): string {
  const base = `/${modelPath(model)}`;
  // The streaming method is a different RPC, not a flag on the same one, and it
  // only emits SSE when asked to.
  return stream ? `${base}:streamGenerateContent?alt=sse` : `${base}:generateContent`;
}

function googleImage(block: ContentBlock): Record<string, unknown> | null {
  if (block.type !== 'image') return null;
  if (block.url !== null) {
    return { fileData: { mimeType: block.mediaType, fileUri: block.url } };
  }
  return { inlineData: { mimeType: block.mediaType, data: block.data } };
}

function googlePart(
  block: ContentBlock,
  toolNames: ReadonlyMap<string, string>,
): Record<string, unknown> | null {
  switch (block.type) {
    case 'text':
      return { text: block.text };
    case 'thinking':
      // A thought is only accepted back with the signature that proved it; the
      // pivot has none here, so re-sending the text would read as an ordinary
      // answer. Dropping it is the honest option.
      return null;
    case 'image':
      return googleImage(block);
    case 'tool_use':
      return { functionCall: { name: block.name, args: block.input } };
    case 'tool_result':
      return {
        functionResponse: {
          // Google keys a response by function name, and the pivot's result only
          // remembers the call id — so the name is recovered from the call.
          name: toolNames.get(block.toolUseId) ?? block.toolUseId,
          response: { content: joinText(block.content) },
        },
      };
  }
}

function contentsOf(messages: readonly CanonicalMessage[]): unknown[] {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') toolNames.set(block.id, block.name);
    }
  }

  const contents: unknown[] = [];
  for (const message of messages) {
    const parts: unknown[] = [];
    for (const block of message.content) {
      const part = googlePart(block, toolNames);
      if (part !== null) parts.push(part);
    }
    if (parts.length === 0) continue;
    // Google has two roles: the model's own turns and everything else.
    contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
  }
  return contents;
}

function generationConfig(request: CanonicalRequest): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const sampling = request.sampling;

  if (sampling.temperature !== null) config.temperature = sampling.temperature;
  if (sampling.topP !== null) config.topP = sampling.topP;
  if (sampling.topK !== null) config.topK = sampling.topK;
  if (sampling.maxTokens !== null) config.maxOutputTokens = sampling.maxTokens;
  if (sampling.stop.length > 0) config.stopSequences = sampling.stop;
  if (sampling.seed !== null) config.seed = sampling.seed;
  if (sampling.presencePenalty !== null) config.presencePenalty = sampling.presencePenalty;
  if (sampling.frequencyPenalty !== null) config.frequencyPenalty = sampling.frequencyPenalty;

  const format = request.responseFormat;
  if (format !== null && format.type !== 'text') {
    config.responseMimeType = 'application/json';
    if (format.type === 'json_schema' && format.jsonSchema !== null) {
      config.responseSchema = format.jsonSchema;
    }
  }
  return config;
}

function toolConfig(request: CanonicalRequest): Record<string, unknown> | null {
  const choice = request.toolChoice;
  if (choice === null) return null;
  if (choice === 'auto') return { mode: 'AUTO' };
  if (choice === 'none') return { mode: 'NONE' };
  if (choice === 'required') return { mode: 'ANY' };
  return { mode: 'ANY', allowedFunctionNames: [choice.name] };
}

export function encodeGoogleRequest(request: CanonicalRequest): EncodedRequest {
  const body: Record<string, unknown> = { ...request.extras, contents: contentsOf(request.messages) };

  if (request.system.length > 0) {
    body.systemInstruction = { parts: request.system.map((block) => ({ text: block.text })) };
  }

  const config = generationConfig(request);
  if (Object.keys(config).length > 0) body.generationConfig = config;

  if (request.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description !== null ? { description: tool.description } : {}),
          parameters: tool.parameters,
        })),
      },
    ];
  }

  const tooling = toolConfig(request);
  if (tooling !== null) body.toolConfig = { functionCallingConfig: tooling };

  return { path: googlePath(request.model, request.stream), body };
}

/**
 * This family's finish reasons, read as the pivot's.
 *
 * The safety family — `SAFETY`, `RECITATION` and the blocklist reasons — are all
 * a refusal to answer, which is the pivot's `content_filter`. Anything else,
 * including the `MALFORMED_FUNCTION_CALL` a broken tool loop produces, is `error`.
 */
export function googleFinishReason(value: unknown): FinishReason {
  switch (str(value) ?? '') {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return 'content_filter';
    default:
      return 'error';
  }
}

export function googleUsage(value: unknown): Usage {
  const record = asRecord(value);
  if (record === null) return zeroUsage();

  const inputTokens = num(record.promptTokenCount) ?? 0;
  const outputTokens = num(record.candidatesTokenCount) ?? 0;

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: num(record.cachedContentTokenCount) ?? 0,
    reasoningTokens: num(record.thoughtsTokenCount) ?? 0,
    totalTokens: num(record.totalTokenCount) ?? inputTokens + outputTokens,
  };
}

/** One `part` of a Google body, read as a pivot block. */
export function decodeGooglePart(value: unknown, context: CodecContext): ContentBlock | null {
  const part = asRecord(value);
  if (part === null) return null;

  if (typeof part.text === 'string') {
    // Google marks a reasoning part with `thought`; the text is otherwise an
    // ordinary answer.
    if (part.thought === true) return { type: 'thinking', text: part.text, signature: null };
    return { type: 'text', text: part.text };
  }

  const call = asRecord(part.functionCall);
  if (call !== null) {
    return {
      type: 'tool_use',
      id: str(call.id) ?? context.ids.toolCall(),
      name: str(call.name) ?? '',
      input: asRecord(call.args) ?? {},
    };
  }

  const inline = asRecord(part.inlineData);
  if (inline !== null) {
    return {
      type: 'image',
      mediaType: str(inline.mimeType) ?? '',
      data: str(inline.data) ?? '',
      url: null,
    };
  }

  const file = asRecord(part.fileData);
  if (file !== null) {
    return {
      type: 'image',
      mediaType: str(file.mimeType) ?? '',
      data: '',
      url: str(file.fileUri) ?? null,
    };
  }

  return null;
}

export function decodeGoogleResponse(body: unknown, context: CodecContext): CanonicalResult {
  const record = asRecord(body) ?? {};
  const candidate = asRecord(arr(record.candidates)[0]) ?? {};
  const content = asRecord(candidate.content) ?? {};
  const blocks: ContentBlock[] = [];

  for (const part of arr(content.parts)) {
    const decoded = decodeGooglePart(part, context);
    if (decoded !== null) blocks.push(decoded);
  }

  return {
    // Google reports no id and no creation time, so both come from the caller.
    id: context.ids.chatCompletion(),
    model: str(record.modelVersion) ?? context.model,
    created: context.now(),
    message: { role: 'assistant', content: blocks, name: null, toolCallId: null },
    finishReason: googleFinishReason(candidate.finishReason),
    usage: googleUsage(record.usageMetadata),
  };
}

export function googleError(input: ErrorInput): ApiError {
  const record = asRecord(input.body);
  const error = asRecord(record?.error);
  const message = str(error?.message) ?? str(record?.message) ?? statusMessage(input.status);

  // Google uses canonical HTTP codes and a `status` string that mostly restates
  // them, so the status string is only a tiebreaker — for the `RESOURCE_EXHAUSTED`
  // that a 429 carries, which the pivot reads as a rate limit unless a manifest's
  // own error rule says the account is out of quota.
  return {
    kind: httpErrorKind(input.status, str(error?.status) ?? null),
    message,
    provider: null,
    retryAfterSeconds: input.retryAfterSeconds,
    requestId: null,
  };
}
