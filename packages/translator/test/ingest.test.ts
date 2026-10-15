import { describe, expect, it } from 'vitest';

import { ingestRequest } from '../src/ingest/index.ts';

/**
 * Ingest, surface by surface.
 *
 * The tests are written against `ingestRequest` rather than the four functions
 * where the point is that a real client body survives, because that is the path
 * the server takes and it also exercises the surface schemas.
 */

const DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

describe('chat-completions', () => {
  it('hoists system and developer turns into one system block list', () => {
    const request = ingestRequest('chat-completions', {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'developer', content: 'Prefer tables.' },
        { role: 'user', content: 'hello' },
      ],
    });

    expect(request.system).toEqual([
      { type: 'text', text: 'You are terse.' },
      { type: 'text', text: 'Prefer tables.' },
    ]);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]?.role).toBe('user');
  });

  it('appends tool calls after the content they followed', () => {
    const request = ingestRequest('chat-completions', {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'what is the weather' },
        {
          role: 'assistant',
          content: 'Let me check.',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Jakarta"}' } },
          ],
        },
      ],
    });

    expect(request.messages[1]?.content).toEqual([
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Jakarta' } },
    ]);
  });

  it('keeps a tool turn as a tool turn, with its call id', () => {
    const request = ingestRequest('chat-completions', {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: '32 degrees', tool_call_id: 'call_1' },
      ],
    });

    expect(request.messages[1]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: '32 degrees' }],
    });
  });

  it('inlines a base64 data URL and carries a remote one by reference', () => {
    const request = ingestRequest('chat-completions', {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'compare' },
            { type: 'image_url', image_url: { url: DATA_URL } },
            { type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
          ],
        },
      ],
    });

    expect(request.messages[0]?.content).toEqual([
      { type: 'text', text: 'compare' },
      { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', url: null },
      { type: 'image', mediaType: '', data: '', url: 'https://example.test/a.png' },
    ]);
  });

  it('normalises sampling and keeps the fields the pivot does not model', () => {
    const request = ingestRequest('chat-completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      stop: 'STOP',
      temperature: 0.4,
      logit_bias: { '50256': -100 },
      user: 'operator',
      response_format: { type: 'json_object' },
    });

    expect(request.sampling).toMatchObject({ temperature: 0.4, stop: ['STOP'], topK: null });
    expect(request.responseFormat).toEqual({ type: 'json_object', jsonSchema: null });
    expect(request.extras).toEqual({ logit_bias: { '50256': -100 }, user: 'operator' });
  });

  it('reads a named tool choice out of its OpenAI wrapper', () => {
    const request = ingestRequest('chat-completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { type: 'function', function: { name: 'lookup', description: 'Look something up', parameters: { type: 'object' } } },
      ],
      tool_choice: { type: 'function', function: { name: 'lookup' } },
    });

    expect(request.tools).toEqual([
      { name: 'lookup', description: 'Look something up', parameters: { type: 'object' } },
    ]);
    expect(request.toolChoice).toEqual({ type: 'tool', name: 'lookup' });
  });

  it('defaults a tool with no description or parameters to null and an empty object', () => {
    const request = ingestRequest('chat-completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'ping' } }],
    });

    expect(request.tools).toEqual([{ name: 'ping', description: null, parameters: {} }]);
  });

  it('absorbs malformed tool arguments rather than failing the turn', () => {
    const request = ingestRequest('chat-completions', {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'f', arguments: '{not json' } }],
        },
      ],
    });

    expect(request.messages[1]?.content).toEqual([
      { type: 'tool_use', id: 'call_9', name: 'f', input: {} },
    ]);
  });
});

describe('messages', () => {
  it('hoists a string system and keeps a tool result inside its user turn', () => {
    const request = ingestRequest('messages', {
      model: 'claude-sonnet-4',
      max_tokens: 1024,
      system: 'Be brief.',
      messages: [
        { role: 'user', content: 'run it' },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              is_error: true,
              content: [{ type: 'text', text: 'boom' }],
            },
          ],
        },
      ],
    });

    expect(request.system).toEqual([{ type: 'text', text: 'Be brief.' }]);
    expect(request.messages[1]).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'toolu_1',
          isError: true,
          content: [{ type: 'text', text: 'boom' }],
        },
      ],
    });
  });

  it('reads a thinking block and its signature', () => {
    const request = ingestRequest('messages', {
      model: 'claude-sonnet-4',
      max_tokens: 1024,
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }] },
      ],
    });

    expect(request.messages[0]?.content).toEqual([
      { type: 'thinking', text: 'hmm', signature: 'sig' },
    ]);
  });

  it('reads tools from input_schema and maps any to required', () => {
    const request = ingestRequest('messages', {
      model: 'claude-sonnet-4',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'search', description: 'Search', input_schema: { type: 'object' } }],
      tool_choice: { type: 'any' },
      top_k: 5,
    });

    expect(request.tools).toEqual([
      { name: 'search', description: 'Search', parameters: { type: 'object' } },
    ]);
    expect(request.toolChoice).toBe('required');
    expect(request.sampling.topK).toBe(5);
    expect(request.sampling.maxTokens).toBe(1024);
  });

  it('leaves thinking config in extras, where the codec can find it again', () => {
    const request = ingestRequest('messages', {
      model: 'claude-sonnet-4',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 2048 },
    });

    expect(request.extras).toEqual({ thinking: { type: 'enabled', budget_tokens: 2048 } });
  });
});

describe('responses', () => {
  it('turns a bare string input into one user turn', () => {
    const request = ingestRequest('responses', {
      model: 'gpt-5',
      input: 'summarise this',
      instructions: 'Be terse.',
    });

    expect(request.system).toEqual([{ type: 'text', text: 'Be terse.' }]);
    expect(request.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'summarise this' }], name: null, toolCallId: null },
    ]);
  });

  it('splits a function call and its output into their own turns', () => {
    const request = ingestRequest('responses', {
      model: 'gpt-5',
      input: [
        { type: 'message', role: 'user', content: 'weather?' },
        { type: 'function_call', call_id: 'call_7', name: 'get_weather', arguments: '{"city":"Bogor"}' },
        { type: 'function_call_output', call_id: 'call_7', output: 'raining' },
      ],
    });

    expect(request.messages).toHaveLength(3);
    expect(request.messages[1]?.content).toEqual([
      { type: 'tool_use', id: 'call_7', name: 'get_weather', input: { city: 'Bogor' } },
    ]);
    expect(request.messages[2]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_7',
      content: [{ type: 'tool_result', toolUseId: 'call_7', isError: false, content: [{ type: 'text', text: 'raining' }] }],
    });
  });

  it('reads a reasoning item as a thinking block', () => {
    const request = ingestRequest('responses', {
      model: 'gpt-5',
      input: [
        { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'weighed it' }] },
        { type: 'message', role: 'user', content: 'go' },
      ],
    });

    expect(request.messages[0]?.content).toEqual([
      { type: 'thinking', text: 'weighed it', signature: null },
    ]);
  });

  it('carries previous_response_id in extras so the dispatcher can see it', () => {
    const request = ingestRequest('responses', {
      model: 'gpt-5',
      input: 'again',
      previous_response_id: 'resp_abc',
      store: false,
    });

    expect(request.extras).toEqual({ previous_response_id: 'resp_abc', store: false });
  });

  it('reads the flat responses tool shape', () => {
    const request = ingestRequest('responses', {
      model: 'gpt-5',
      input: 'go',
      tools: [{ type: 'function', name: 'lookup', description: 'Look up', parameters: { type: 'object' } }],
      tool_choice: 'required',
    });

    expect(request.tools).toEqual([
      { name: 'lookup', description: 'Look up', parameters: { type: 'object' } },
    ]);
    expect(request.toolChoice).toBe('required');
  });
});

describe('completions', () => {
  it('turns a bare prompt into one user turn', () => {
    const request = ingestRequest('completions', {
      model: 'gpt-3.5-turbo-instruct',
      prompt: 'def fib(n):',
      max_tokens: 64,
      suffix: 'return',
    });

    expect(request.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'def fib(n):' }], name: null, toolCallId: null },
    ]);
    expect(request.sampling.maxTokens).toBe(64);
    expect(request.extras).toEqual({ suffix: 'return' });
  });

  it('joins an array prompt, which the legacy surface reads as a batch', () => {
    const request = ingestRequest('completions', {
      model: 'gpt-3.5-turbo-instruct',
      prompt: ['one', 'two'],
    });

    expect(request.messages[0]?.content).toEqual([{ type: 'text', text: 'one\ntwo' }]);
  });
});

describe('ingestRequest', () => {
  it('rejects a body that is not the surface it claims to be', () => {
    expect(() => ingestRequest('messages', { model: 'x', messages: [] })).toThrow();
  });

  it('rejects a chat body with no messages', () => {
    expect(() => ingestRequest('chat-completions', { model: 'gpt-4o', messages: [] })).toThrow();
  });

  it('leaves stream false when the client did not ask to stream', () => {
    const request = ingestRequest('chat-completions', {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(request.stream).toBe(false);
  });
});
