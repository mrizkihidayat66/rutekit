import { createIdFactory } from '@shared';
import { describe, expect, it } from 'vitest';

import { chooseRoute } from '../src/route.ts';
import { codecFor, createBlockBuilder, httpErrorKind } from '../src/index.ts';
import {
  anthropicError,
  decodeAnthropicResponse,
  encodeAnthropicRequest,
} from '../src/codecs/anthropic.ts';
import { createAnthropicStreamDecoder } from '../src/codecs/anthropic-stream.ts';
import {
  decodeGoogleResponse,
  encodeGoogleRequest,
  googleError,
  googleFinishReason,
} from '../src/codecs/google.ts';
import { createGoogleStreamDecoder } from '../src/codecs/google-stream.ts';
import {
  decodeOpenAiResponse,
  encodeOpenAiRequest,
  openAiError,
  openAiFinishReason,
} from '../src/codecs/openai.ts';
import { createOpenAiStreamDecoder } from '../src/codecs/openai-stream.ts';
import type { CanonicalRequest } from '../src/canonical-request.ts';
import type { CanonicalStreamEvent } from '../src/canonical-stream.ts';
import type { CodecContext } from '../src/codecs/types.ts';

/**
 * The route decision, the three wire codecs, and the block builder they share.
 *
 * These assert the behaviours each codec documents rather than whole bodies: the
 * field a provider insists on, the one the pivot cannot carry, and the point at
 * which a held-back `finish` is finally released.
 */

/** A deterministic id factory: every byte is zero, so every id is the alphabet's first char. */
const ids = createIdFactory((bytes) => new Uint8Array(bytes));

function context(model = 'gpt-4o'): CodecContext {
  return { now: () => 1_700_000_000, ids, model };
}

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'gpt-4o',
    system: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], name: null, toolCallId: null }],
    sampling: {
      temperature: null,
      topP: null,
      topK: null,
      maxTokens: null,
      stop: [],
      seed: null,
      presencePenalty: null,
      frequencyPenalty: null,
    },
    tools: [],
    toolChoice: null,
    responseFormat: null,
    stream: false,
    extras: {},
    ...overrides,
  };
}

function typesOf(events: readonly CanonicalStreamEvent[]): string[] {
  return events.map((event) => event.type);
}

describe('chooseRoute', () => {
  it('routes a dialect to a provider speaking the same dialect direct', () => {
    expect(chooseRoute('chat-completions', 'openai')).toBe('direct');
    expect(chooseRoute('messages', 'anthropic')).toBe('direct');
  });

  it('pivots every other pair, including the two that look close', () => {
    expect(chooseRoute('chat-completions', 'anthropic')).toBe('pivot');
    expect(chooseRoute('chat-completions', 'google')).toBe('pivot');
    expect(chooseRoute('messages', 'openai')).toBe('pivot');
    // `/v1/completions` and `/v1/responses` are different APIs, not different
    // spellings, so they never take the direct route.
    expect(chooseRoute('completions', 'openai')).toBe('pivot');
    expect(chooseRoute('responses', 'openai')).toBe('pivot');
  });
});

describe('codecFor', () => {
  it('has a codec for the three known families and none for custom', () => {
    expect(codecFor('openai')).not.toBeNull();
    expect(codecFor('anthropic')).not.toBeNull();
    expect(codecFor('google')).not.toBeNull();
    // Not defaulted to the OpenAI codec: a provider whose wire rutekit does not
    // know cannot be reached through `/v1` at all.
    expect(codecFor('custom')).toBeNull();
  });
});

describe('httpErrorKind', () => {
  it('tells an exhausted quota from a rate limit, which arrive as the same status', () => {
    expect(httpErrorKind(429, 'insufficient_quota')).toBe('quota_exhausted');
    expect(httpErrorKind(429, 'RESOURCE_EXHAUSTED')).toBe('rate_limit');
    expect(httpErrorKind(429, null)).toBe('rate_limit');
  });

  it('reads the status when there is no code, with 529 as the overloaded alias', () => {
    expect(httpErrorKind(401, null)).toBe('authentication');
    expect(httpErrorKind(402, null)).toBe('quota_exhausted');
    expect(httpErrorKind(403, null)).toBe('permission');
    expect(httpErrorKind(404, null)).toBe('not_found');
    expect(httpErrorKind(408, null)).toBe('timeout');
    expect(httpErrorKind(529, null)).toBe('unavailable');
    expect(httpErrorKind(503, null)).toBe('unavailable');
    expect(httpErrorKind(500, null)).toBe('upstream_error');
  });
});

describe('OpenAI request encoding', () => {
  it('hoists the system prompt into the message list and names the chat path', () => {
    const encoded = encodeOpenAiRequest(
      request({ system: [{ type: 'text', text: 'be terse' }] }),
    );

    expect(encoded.path).toBe('/chat/completions');
    expect(encoded.body.messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('turns a tool result turn into the role this family looks for', () => {
    const encoded = encodeOpenAiRequest(
      request({
        messages: [
          {
            role: 'tool',
            content: [{ type: 'tool_result', toolUseId: 'call_1', isError: false, content: [{ type: 'text', text: '32' }] }],
            name: null,
            toolCallId: null,
          },
        ],
      }),
    );

    expect(encoded.body.messages).toEqual([{ role: 'tool', tool_call_id: 'call_1', content: '32' }]);
  });

  it('carries tool calls as a JSON string, and nulls content when there is no text', () => {
    const encoded = encodeOpenAiRequest(
      request({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Jakarta' } }],
            name: null,
            toolCallId: null,
          },
        ],
      }),
    );

    expect(encoded.body.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Jakarta"}' } },
        ],
      },
    ]);
  });

  it('asks for usage on a stream, since the pivot has no field for the opt-in', () => {
    const encoded = encodeOpenAiRequest(request({ stream: true }));
    expect(encoded.body.stream_options).toEqual({ include_usage: true });
  });

  it('lets a client keep its own stream_options, because extras go first', () => {
    const encoded = encodeOpenAiRequest(request({ stream: true, extras: { stream_options: { include_usage: false } } }));
    expect(encoded.body.stream_options).toEqual({ include_usage: false });
  });

  it('lets the pivot win over an extra that shares a field name', () => {
    const encoded = encodeOpenAiRequest(request({ model: 'gpt-4o', extras: { model: 'spoofed' } }));
    expect(encoded.body.model).toBe('gpt-4o');
  });

  it('switches to a part list only when an image forces it', () => {
    const encoded = encodeOpenAiRequest(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'compare' },
              { type: 'image', mediaType: 'image/png', data: 'AAAA', url: null },
            ],
            name: null,
            toolCallId: null,
          },
        ],
      }),
    );

    expect(encoded.body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'compare' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]);
  });

  it('drops top_k, which this family has no spelling for', () => {
    const encoded = encodeOpenAiRequest(request({ sampling: { ...request().sampling, topK: 5 } }));
    expect('top_k' in encoded.body).toBe(false);
  });
});

describe('OpenAI response decoding', () => {
  it('reads reasoning into a thinking block and content into text', () => {
    const result = decodeOpenAiResponse(
      {
        id: 'cmpl-1',
        model: 'gpt-4o',
        created: 1_700_000_001,
        choices: [
          { message: { role: 'assistant', reasoning_content: 'hmm', content: 'answer' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      context(),
    );

    expect(result.message.content).toEqual([
      { type: 'thinking', text: 'hmm', signature: null },
      { type: 'text', text: 'answer' },
    ]);
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 15,
    });
  });

  it('reads a tool call and its arguments', () => {
    const result = decodeOpenAiResponse(
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', function: { name: 'f', arguments: '{"a":1}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      context(),
    );

    expect(result.message.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'f', input: { a: 1 } },
    ]);
    expect(result.finishReason).toBe('tool_calls');
  });

  it('falls back to the context for an id and model the provider omitted', () => {
    const result = decodeOpenAiResponse({ choices: [] }, context('my-model'));
    expect(result.model).toBe('my-model');
    expect(result.id).not.toBe('');
    expect(result.created).toBe(1_700_000_000);
  });

  it('calls an unrecognised finish reason an error, never a stop', () => {
    expect(openAiFinishReason(undefined)).toBe('error');
    expect(openAiFinishReason('weird')).toBe('error');
    expect(openAiFinishReason('function_call')).toBe('tool_calls');
  });
});

describe('OpenAI error decoding', () => {
  it('reads the code for the kind and keeps the request id', () => {
    const error = openAiError({
      status: 429,
      body: { error: { message: 'out of budget', code: 'insufficient_quota' }, request_id: 'req_1' },
      retryAfterSeconds: 30,
    });

    expect(error.kind).toBe('quota_exhausted');
    expect(error.message).toBe('out of budget');
    expect(error.requestId).toBe('req_1');
    expect(error.retryAfterSeconds).toBe(30);
  });
});

describe('OpenAI stream decoding', () => {
  it('opens with start and closes with finish when [DONE] arrives', () => {
    const decoder = createOpenAiStreamDecoder(context());
    const opened = decoder.push(
      'data: {"id":"cmpl-1","model":"gpt-4o","created":1700000000,"choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}\n\n',
    );

    expect(typesOf(opened)).toEqual(['start', 'block_start', 'text_delta']);

    const closed = decoder.push(
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\ndata: [DONE]\n\n',
    );

    const finish = closed.find((event) => event.type === 'finish');
    expect(finish).toMatchObject({
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
  });

  it('holds the finish until the stream ends, because usage arrives after the reason', () => {
    const decoder = createOpenAiStreamDecoder(context());
    const events = decoder.push(
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    );

    expect(events.some((event) => event.type === 'finish')).toBe(false);
    expect(decoder.flush().some((event) => event.type === 'finish')).toBe(true);
  });

  it('opens a tool block once even when the provider repeats the name', () => {
    const decoder = createOpenAiStreamDecoder(context());
    const first = decoder.push(
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"f","arguments":""}}]}}]}\n\n',
    );
    const second = decoder.push(
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"f","arguments":"{\\"a\\":1}"}}]}}]}\n\n',
    );

    expect(typesOf(first)).toEqual(['start', 'block_start']);
    expect(typesOf(second)).toEqual(['input_json_delta']);
  });

  it('ignores a frame that is not JSON', () => {
    const decoder = createOpenAiStreamDecoder(context());
    expect(decoder.push('data: not-json\n\n')).toEqual([]);
  });
});

describe('Anthropic request encoding', () => {
  it('defaults max_tokens, which this family requires', () => {
    const encoded = encodeAnthropicRequest(request());
    expect(encoded.path).toBe('/messages');
    expect(encoded.body.max_tokens).toBe(4096);
  });

  it('carries the system prompt at the top level, not in the message list', () => {
    const encoded = encodeAnthropicRequest(request({ system: [{ type: 'text', text: 'be terse' }] }));
    expect(encoded.body.system).toEqual([{ type: 'text', text: 'be terse' }]);
    expect(encoded.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
  });

  it('maps every tool-choice spelling', () => {
    expect(encodeAnthropicRequest(request({ toolChoice: 'auto' })).body.tool_choice).toEqual({ type: 'auto' });
    expect(encodeAnthropicRequest(request({ toolChoice: 'none' })).body.tool_choice).toEqual({ type: 'none' });
    expect(encodeAnthropicRequest(request({ toolChoice: 'required' })).body.tool_choice).toEqual({ type: 'any' });
    expect(encodeAnthropicRequest(request({ toolChoice: { type: 'tool', name: 'f' } })).body.tool_choice).toEqual({
      type: 'tool',
      name: 'f',
    });
  });

  it('drops the penalties this family has no spelling for', () => {
    const encoded = encodeAnthropicRequest(
      request({ sampling: { ...request().sampling, seed: 7, presencePenalty: 1 } }),
    );
    expect('seed' in encoded.body).toBe(false);
    expect('presence_penalty' in encoded.body).toBe(false);
  });
});

describe('Anthropic response decoding', () => {
  it('keeps a thinking block signature, which the pivot otherwise cannot carry', () => {
    const result = decodeAnthropicResponse(
      {
        id: 'msg_1',
        model: 'claude',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig-abc' },
          { type: 'text', text: 'answer' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4 },
      },
      context('claude'),
    );

    expect(result.message.content).toEqual([
      { type: 'thinking', text: 'hmm', signature: 'sig-abc' },
      { type: 'text', text: 'answer' },
    ]);
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 4,
      reasoningTokens: 0,
      totalTokens: 15,
    });
  });

  it('drops a block kind the pivot has no spelling for', () => {
    const result = decodeAnthropicResponse(
      { content: [{ type: 'redacted_thinking', data: 'x' }, { type: 'text', text: 'ok' }] },
      context(),
    );
    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('maps the stop reasons, with pause_turn reading as a stop', () => {
    expect(decodeAnthropicResponse({ stop_reason: 'pause_turn' }, context()).finishReason).toBe('stop');
    expect(decodeAnthropicResponse({ stop_reason: 'max_tokens' }, context()).finishReason).toBe('length');
    expect(decodeAnthropicResponse({ stop_reason: 'tool_use' }, context()).finishReason).toBe('tool_calls');
    expect(decodeAnthropicResponse({ stop_reason: 'refusal' }, context()).finishReason).toBe('content_filter');
  });
});

describe('Anthropic error decoding', () => {
  it("reads the vendor's own type, which is more precise than the status", () => {
    expect(anthropicError({ status: 400, body: { error: { type: 'billing_error', message: 'no' } }, retryAfterSeconds: null }).kind).toBe(
      'quota_exhausted',
    );
    expect(
      anthropicError({ status: 529, body: { error: { type: 'overloaded_error', message: 'busy' } }, retryAfterSeconds: null }).kind,
    ).toBe('unavailable');
  });

  it('falls back to the status when the type is unknown', () => {
    expect(anthropicError({ status: 500, body: {}, retryAfterSeconds: null }).kind).toBe('upstream_error');
  });
});

describe('Anthropic stream decoding', () => {
  it('takes input tokens from message_start and holds the finish for message_stop', () => {
    const decoder = createAnthropicStreamDecoder(context('claude'));
    const opened = decoder.push(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude","usage":{"input_tokens":10,"cache_read_input_tokens":4}}}\n\n',
    );

    expect(opened[0]).toMatchObject({
      type: 'start',
      id: 'msg_1',
      usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 0 },
    });

    const closed = decoder.push(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    );

    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4, totalTokens: 15 },
    });
  });

  it('drops signature_delta, which is why a Claude client is routed direct', () => {
    const decoder = createAnthropicStreamDecoder(context('claude'));
    const events = decoder.push(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}\n\n',
    );
    expect(events).toEqual([]);
  });
});

describe('Google request encoding', () => {
  it('puts the model in the path, and uses a different method to stream', () => {
    expect(encodeGoogleRequest(request({ model: 'gemini-1.5-pro' })).path).toBe(
      '/models/gemini-1.5-pro:generateContent',
    );
    expect(encodeGoogleRequest(request({ model: 'gemini-1.5-pro', stream: true })).path).toBe(
      '/models/gemini-1.5-pro:streamGenerateContent?alt=sse',
    );
  });

  it('carries the system prompt as a systemInstruction and sampling as camelCase', () => {
    const encoded = encodeGoogleRequest(
      request({
        system: [{ type: 'text', text: 'be terse' }],
        sampling: { ...request().sampling, maxTokens: 128, temperature: 0.5 },
      }),
    );

    expect(encoded.body.systemInstruction).toEqual({ parts: [{ text: 'be terse' }] });
    expect(encoded.body.generationConfig).toEqual({ temperature: 0.5, maxOutputTokens: 128 });
  });

  it('wraps tools in a functionDeclarations list', () => {
    const encoded = encodeGoogleRequest(
      request({ tools: [{ name: 'f', description: 'does f', parameters: { type: 'object' } }] }),
    );

    expect(encoded.body.tools).toEqual([
      { functionDeclarations: [{ name: 'f', description: 'does f', parameters: { type: 'object' } }] },
    ]);
  });

  it('maps a named tool choice to an ANY mode limited to that name', () => {
    const encoded = encodeGoogleRequest(request({ toolChoice: { type: 'tool', name: 'f' } }));
    expect(encoded.body.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['f'] },
    });
  });

  it('recovers a tool result name from the call that produced it', () => {
    const encoded = encodeGoogleRequest(
      request({
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} }], name: null, toolCallId: null },
          {
            role: 'tool',
            content: [{ type: 'tool_result', toolUseId: 'call_1', isError: false, content: [{ type: 'text', text: '32' }] }],
            name: null,
            toolCallId: null,
          },
        ],
      }),
    );

    const contents = encoded.body.contents as { role: string; parts: Record<string, unknown>[] }[];
    expect(contents[1]?.parts[0]).toEqual({ functionResponse: { name: 'get_weather', response: { content: '32' } } });
  });
});

describe('Google response decoding', () => {
  it('reads a function call and an inline image', () => {
    const result = decodeGoogleResponse(
      {
        modelVersion: 'gemini-1.5-pro',
        candidates: [
          {
            content: {
              parts: [
                { text: 'answer' },
                { functionCall: { id: 'call_1', name: 'f', args: { a: 1 } } },
                { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
      },
      context('gemini-1.5-pro'),
    );

    expect(result.message.content).toEqual([
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 'call_1', name: 'f', input: { a: 1 } },
      { type: 'image', mediaType: 'image/png', data: 'AAAA', url: null },
    ]);
    expect(result.usage.totalTokens).toBe(5);
  });

  it('reads a thought part as a thinking block', () => {
    const result = decodeGoogleResponse(
      { candidates: [{ content: { parts: [{ text: 'hmm', thought: true }] } }] },
      context(),
    );
    expect(result.message.content).toEqual([{ type: 'thinking', text: 'hmm', signature: null }]);
  });

  it('reads the safety family as a content filter and a broken call as an error', () => {
    expect(googleFinishReason('SAFETY')).toBe('content_filter');
    expect(googleFinishReason('RECITATION')).toBe('content_filter');
    expect(googleFinishReason('MALFORMED_FUNCTION_CALL')).toBe('error');
    expect(googleFinishReason('MAX_TOKENS')).toBe('length');
  });
});

describe('Google error decoding', () => {
  it('uses the status as the authority and the status string as a tiebreaker', () => {
    const error = googleError({
      status: 400,
      body: { error: { message: 'bad request', status: 'INVALID_ARGUMENT' } },
      retryAfterSeconds: null,
    });
    expect(error.kind).toBe('invalid_request');
    expect(error.message).toBe('bad request');
  });
});

describe('Google stream decoding', () => {
  it('emits the finish at flush, because there is no [DONE] sentinel', () => {
    const decoder = createGoogleStreamDecoder(context('gemini-1.5-pro'));
    const pushed = decoder.push(
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}\n\n',
    );

    expect(typesOf(pushed)).toEqual(['start', 'block_start', 'text_delta']);
    expect(pushed.some((event) => event.type === 'finish')).toBe(false);

    const flushed = decoder.flush();
    const finish = flushed.find((event) => event.type === 'finish');
    expect(finish).toMatchObject({
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });
  });

  it('writes a whole function call as one argument fragment', () => {
    const decoder = createGoogleStreamDecoder(context('gemini-1.5-pro'));
    const events = decoder.push(
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"f","args":{"a":1}}}]}}]}\n\n',
    );

    const args = events.find((event) => event.type === 'input_json_delta');
    expect(args).toMatchObject({ type: 'input_json_delta', partialJson: '{"a":1}' });
  });
});

describe('createBlockBuilder', () => {
  it('closes an open block when a different kind starts', () => {
    const builder = createBlockBuilder();
    expect(typesOf(builder.text('a'))).toEqual(['block_start', 'text_delta']);
    expect(typesOf(builder.thinking('b'))).toEqual(['block_stop', 'block_start', 'thinking_delta']);
  });

  it('does not open a second block for the same tool key', () => {
    const builder = createBlockBuilder();
    expect(typesOf(builder.toolStart(0, 'call_1', 'f'))).toEqual(['block_start']);
    expect(builder.toolStart(0, 'call_1', 'f')).toEqual([]);
    expect(typesOf(builder.toolArguments(0, '{"a":1}'))).toEqual(['input_json_delta']);
  });

  it('closes an open text block and a tool block when the turn ends', () => {
    const builder = createBlockBuilder();
    builder.text('a');
    expect(typesOf(builder.close())).toEqual(['block_stop']);

    const withTool = createBlockBuilder();
    // A tool block is closed at end of turn, never when another kind starts.
    withTool.toolStart(0, 'call_1', 'f');
    expect(typesOf(withTool.close())).toEqual(['block_stop']);
  });
});
