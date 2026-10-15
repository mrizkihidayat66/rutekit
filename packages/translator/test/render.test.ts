import { describe, expect, it } from 'vitest';

import type { CanonicalResult } from '../src/canonical-result.ts';
import type { CanonicalStreamEvent } from '../src/canonical-stream.ts';
import { createStreamRenderer, renderError, renderResult } from '../src/render/index.ts';
import type { StreamRenderer } from '../src/render/shared.ts';

/**
 * Render, surface by surface, and the stream encoders that feed them.
 *
 * The tests assert the behaviours the renderers document rather than their whole
 * output: which frame a Claude client needs first, where the OpenAI stream puts
 * usage, and what the responses stream has to have kept by the time it closes.
 */

interface ParsedFrame {
  readonly event: string | null;
  readonly data: string;
}

function framesOf(rendered: string): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  for (const chunk of rendered.split('\n\n')) {
    if (chunk.trim() === '') continue;
    let event: string | null = null;
    const data: string[] = [];
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length);
      else if (line.startsWith('data: ')) data.push(line.slice('data: '.length));
    }
    frames.push({ event, data: data.join('\n') });
  }
  return frames;
}

function json(frames: readonly ParsedFrame[], index: number): Record<string, unknown> {
  const frame = frames[index];
  if (frame === undefined) throw new Error(`no frame at ${index}`);
  return JSON.parse(frame.data) as Record<string, unknown>;
}

function run(renderer: StreamRenderer, events: readonly CanonicalStreamEvent[]): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  for (const event of events) {
    const rendered = renderer.render(event);
    if (rendered !== null) frames.push(...framesOf(rendered));
  }
  return frames;
}

const USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 15,
};

function result(overrides: Partial<CanonicalResult> = {}): CanonicalResult {
  return {
    id: 'cmpl-1',
    model: 'gpt-4o',
    created: 1_700_000_000,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      name: null,
      toolCallId: null,
    },
    finishReason: 'stop',
    usage: USAGE,
    ...overrides,
  };
}

const START: CanonicalStreamEvent = {
  type: 'start',
  id: 'cmpl-1',
  model: 'gpt-4o',
  created: 1_700_000_000,
  usage: null,
};

describe('finish-reason flattening', () => {
  it('maps a truncated turn to null on the OpenAI surfaces, never to stop', () => {
    expect(renderResult('chat-completions', result({ finishReason: 'aborted' }))).toMatchObject({
      choices: [{ finish_reason: null }],
    });
    expect(renderResult('chat-completions', result({ finishReason: 'error' }))).toMatchObject({
      choices: [{ finish_reason: null }],
    });
  });

  it('has no content-filter reason on Anthropic, so the turn reads as end_turn', () => {
    expect(renderResult('messages', result({ finishReason: 'content_filter' }))).toMatchObject({
      stop_reason: 'end_turn',
    });
  });

  it('reports a tool-call turn as stop on the legacy text surface', () => {
    expect(renderResult('completions', result({ finishReason: 'tool_calls' }))).toMatchObject({
      choices: [{ finish_reason: 'stop' }],
    });
  });
});

describe('renderChatCompletion', () => {
  it('nulls content rather than emptying it when a turn is only tool calls', () => {
    const rendered = renderResult(
      'chat-completions',
      result({
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Jakarta' } }],
          name: null,
          toolCallId: null,
        },
        finishReason: 'tool_calls',
      }),
    ) as { choices: { message: Record<string, unknown> }[] };

    expect(rendered.choices[0]?.message.content).toBeNull();
    expect(rendered.choices[0]?.message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Jakarta"}' } },
    ]);
  });

  it('carries reasoning text in reasoning_content', () => {
    const rendered = renderResult(
      'chat-completions',
      result({
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'let me think', signature: null },
            { type: 'text', text: 'answer' },
          ],
          name: null,
          toolCallId: null,
        },
      }),
    ) as { choices: { message: Record<string, unknown> }[] };

    expect(rendered.choices[0]?.message.reasoning_content).toBe('let me think');
    expect(rendered.choices[0]?.message.content).toBe('answer');
  });
});

describe('chat-completions stream', () => {
  it('opens with the assistant role and closes with [DONE] after finish', () => {
    const frames = run(createStreamRenderer('chat-completions'), [
      START,
      { type: 'text_delta', index: 0, text: 'hi' },
      { type: 'finish', finishReason: 'stop', usage: USAGE },
    ]);

    expect(json(frames, 0).choices).toEqual([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
    expect(frames.at(-1)?.data).toBe('[DONE]');
  });

  it('puts usage on the closing chunk rather than a choices-empty one', () => {
    const frames = run(createStreamRenderer('chat-completions'), [
      START,
      { type: 'finish', finishReason: 'stop', usage: USAGE },
    ]);

    const closing = json(frames, 1);
    expect(closing.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    expect(closing.choices).toHaveLength(1);
  });

  it('numbers tool calls by position, not by block index', () => {
    const frames = run(createStreamRenderer('chat-completions'), [
      START,
      { type: 'block_start', index: 1, block: { type: 'tool_use', id: 'call_a', name: 'a', input: {} } },
      { type: 'input_json_delta', index: 1, partialJson: '{"x":1}' },
      { type: 'block_start', index: 3, block: { type: 'tool_use', id: 'call_b', name: 'b', input: {} } },
      { type: 'input_json_delta', index: 3, partialJson: '{"y":2}' },
    ]);

    const opened = json(frames, 1).choices as { delta: { tool_calls: { index: number }[] } }[];
    expect(opened[0]?.delta.tool_calls[0]?.index).toBe(0);

    const second = json(frames, 3).choices as { delta: { tool_calls: { index: number }[] } }[];
    expect(second[0]?.delta.tool_calls[0]?.index).toBe(1);

    const args = json(frames, 2).choices as { delta: { tool_calls: { index: number; function: { arguments: string } }[] } }[];
    expect(args[0]?.delta.tool_calls[0]).toEqual({ index: 0, function: { arguments: '{"x":1}' } });
  });

  it('answers a ping with a comment, which no client parses as data', () => {
    const rendered = createStreamRenderer('chat-completions').render({ type: 'ping' });
    expect(rendered).toBe(': ping\n\n');
  });
});

describe('renderMessages', () => {
  it('renders the Anthropic envelope with a mapped stop reason', () => {
    const rendered = renderResult('messages', result({ finishReason: 'length' })) as Record<string, unknown>;

    expect(rendered.type).toBe('message');
    expect(rendered.role).toBe('assistant');
    expect(rendered.stop_reason).toBe('max_tokens');
    expect(rendered.stop_sequence).toBeNull();
  });

  it('carries a remote image by reference and an inline one by value', () => {
    const rendered = renderResult(
      'messages',
      result({
        message: {
          role: 'assistant',
          content: [
            { type: 'image', mediaType: 'image/png', data: '', url: 'https://example.test/a.png' },
            { type: 'image', mediaType: 'image/png', data: 'AAAA', url: null },
          ],
          name: null,
          toolCallId: null,
        },
      }),
    ) as { content: { source: Record<string, unknown> }[] };

    expect(rendered.content[0]?.source).toEqual({ type: 'url', url: 'https://example.test/a.png' });
    expect(rendered.content[1]?.source).toEqual({ type: 'base64', media_type: 'image/png', data: 'AAAA' });
  });

  it('drops a tool result that a codec left on an assistant turn', () => {
    const rendered = renderResult(
      'messages',
      result({
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'ok' },
            { type: 'tool_result', toolUseId: 'call_1', isError: false, content: [] },
          ],
          name: null,
          toolCallId: null,
        },
      }),
    ) as { content: unknown[] };

    expect(rendered.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('reports cache reads only when there were some', () => {
    const withCache = renderResult('messages', result({ usage: { ...USAGE, cachedInputTokens: 4 } })) as {
      usage: Record<string, unknown>;
    };
    const without = renderResult('messages', result()) as { usage: Record<string, unknown> };

    expect(withCache.usage.cache_read_input_tokens).toBe(4);
    expect('cache_read_input_tokens' in without.usage).toBe(false);
  });
});

describe('messages stream', () => {
  it('opens with message_start before any block', () => {
    const frames = run(createStreamRenderer('messages'), [
      START,
      { type: 'block_start', index: 0, block: { type: 'text', text: '' } },
      { type: 'text_delta', index: 0, text: 'hi' },
      { type: 'block_stop', index: 0 },
      { type: 'finish', finishReason: 'stop', usage: USAGE },
    ]);

    expect(frames[0]?.event).toBe('message_start');
    expect(json(frames, 0).type).toBe('message_start');
    expect(frames.map((frame) => frame.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });

  it('takes input tokens from the opening frame when the codec supplied them', () => {
    const frames = run(createStreamRenderer('messages'), [
      { ...START, usage: USAGE },
      { type: 'finish', finishReason: 'stop', usage: USAGE },
    ]);

    const message = json(frames, 0).message as { usage: Record<string, unknown> };
    expect(message.usage).toEqual({ input_tokens: 10, output_tokens: 0 });
  });

  it('answers finish with message_delta then message_stop', () => {
    const rendered = createStreamRenderer('messages').render({
      type: 'finish',
      finishReason: 'tool_calls',
      usage: USAGE,
    });
    const frames = framesOf(rendered ?? '');

    expect(frames.map((frame) => frame.event)).toEqual(['message_delta', 'message_stop']);
    expect((json(frames, 0).delta as Record<string, unknown>).stop_reason).toBe('tool_use');
  });

  it('emits a named ping frame', () => {
    const rendered = createStreamRenderer('messages').render({ type: 'ping' });
    expect(framesOf(rendered ?? '')[0]?.event).toBe('ping');
  });
});

describe('renderCompletion', () => {
  it('keeps only the text, which is all a FIM client can read', () => {
    const rendered = renderResult(
      'completions',
      result({
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'hmm', signature: null },
            { type: 'text', text: 'fn main() {}' },
          ],
          name: null,
          toolCallId: null,
        },
      }),
    ) as { choices: { text: string }[]; object: string };

    expect(rendered.object).toBe('text_completion');
    expect(rendered.choices[0]?.text).toBe('fn main() {}');
  });
});

describe('completions stream', () => {
  it('passes text through and drops what the surface cannot express', () => {
    const renderer = createStreamRenderer('completions');

    expect(renderer.render({ type: 'text_delta', index: 0, text: 'ab' })).not.toBeNull();
    expect(renderer.render({ type: 'thinking_delta', index: 0, text: 'x' })).toBeNull();
    expect(renderer.render({ type: 'block_start', index: 0, block: { type: 'text', text: '' } })).toBeNull();
    expect(renderer.render({ type: 'block_stop', index: 0 })).toBeNull();
  });

  it('closes with usage and [DONE]', () => {
    const frames = run(createStreamRenderer('completions'), [
      START,
      { type: 'finish', finishReason: 'length', usage: USAGE },
    ]);

    expect((json(frames, 1).choices as { finish_reason: string }[])[0]?.finish_reason).toBe('length');
    expect(json(frames, 1).usage).toBeDefined();
    expect(frames.at(-1)?.data).toBe('[DONE]');
  });
});

describe('renderResponse', () => {
  it('flattens blocks into a sibling output list', () => {
    const rendered = renderResult(
      'responses',
      result({
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'reasoning', signature: null },
            { type: 'text', text: 'answer' },
            { type: 'tool_use', id: 'call_1', name: 'f', input: { a: 1 } },
          ],
          name: null,
          toolCallId: null,
        },
      }),
    ) as { output: Record<string, unknown>[]; output_text: string; status: string };

    expect(rendered.status).toBe('completed');
    expect(rendered.output.map((item) => item.type)).toEqual(['reasoning', 'message', 'function_call']);
    expect(rendered.output_text).toBe('answer');
    expect(rendered.output[2]?.call_id).toBe('call_1');
    expect(rendered.output[2]?.arguments).toBe('{"a":1}');
  });
});

describe('responses stream', () => {
  it('numbers every frame in one sequence and opens with response.created', () => {
    const frames = run(createStreamRenderer('responses'), [
      START,
      { type: 'block_start', index: 0, block: { type: 'text', text: '' } },
      { type: 'text_delta', index: 0, text: 'hi' },
    ]);

    expect(frames[0]?.event).toBe('response.created');
    expect(json(frames, 0).sequence_number).toBe(1);
    expect(json(frames, 1).sequence_number).toBe(2);
    expect(json(frames, 2).sequence_number).toBe(3);
  });

  it('carries the whole accumulated output in the closing frame', () => {
    const frames = run(createStreamRenderer('responses'), [
      START,
      { type: 'block_start', index: 0, block: { type: 'text', text: '' } },
      { type: 'text_delta', index: 0, text: 'hel' },
      { type: 'text_delta', index: 0, text: 'lo' },
      { type: 'block_stop', index: 0 },
      { type: 'finish', finishReason: 'stop', usage: USAGE },
    ]);

    const completed = frames.find((frame) => frame.event === 'response.completed');
    const response = json(frames, frames.indexOf(completed!)).response as {
      output: { type: string; content: { text: string }[] }[];
      output_text: string;
    };

    expect(response.output).toHaveLength(1);
    expect(response.output[0]?.content[0]?.text).toBe('hello');
    expect(response.output_text).toBe('hello');
    expect(frames.at(-1)?.data).toBe('[DONE]');
  });

  it('accumulates tool arguments so the completed call is not truncated', () => {
    const frames = run(createStreamRenderer('responses'), [
      START,
      { type: 'block_start', index: 0, block: { type: 'tool_use', id: 'call_1', name: 'f', input: {} } },
      { type: 'input_json_delta', index: 0, partialJson: '{"a"' },
      { type: 'input_json_delta', index: 0, partialJson: ':1}' },
      { type: 'block_stop', index: 0 },
      { type: 'finish', finishReason: 'tool_calls', usage: USAGE },
    ]);

    const completed = frames.find((frame) => frame.event === 'response.completed');
    const response = json(frames, frames.indexOf(completed!)).response as {
      output: { type: string; arguments: string }[];
    };

    expect(response.output[0]?.arguments).toBe('{"a":1}');
  });
});

describe('renderError', () => {
  const error = { kind: 'quota_exhausted' as const, message: 'no budget', provider: null, retryAfterSeconds: null, requestId: null };

  it('uses the Anthropic envelope only for messages', () => {
    expect(renderError('messages', error)).toEqual({
      type: 'error',
      error: { type: 'quota_exhausted', message: 'no budget' },
    });
  });

  it('uses the OpenAI envelope for the other three', () => {
    for (const surface of ['chat-completions', 'responses', 'completions'] as const) {
      expect(renderError(surface, error)).toEqual({
        error: { message: 'no budget', type: 'quota_exhausted', code: null, param: null },
      });
    }
  });
});

describe('dispatch', () => {
  it('picks a renderer per surface and they are distinct', () => {
    const surfaces = ['chat-completions', 'messages', 'completions', 'responses'] as const;
    for (const surface of surfaces) {
      expect(createStreamRenderer(surface)).toBeTypeOf('object');
      expect(renderResult(surface, result())).toBeTypeOf('object');
    }

    const chat = renderResult('chat-completions', result()) as Record<string, unknown>;
    const messages = renderResult('messages', result()) as Record<string, unknown>;
    expect(chat.object).toBe('chat.completion');
    expect(messages.type).toBe('message');
  });
});
