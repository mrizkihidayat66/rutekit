import { createIdFactory } from '@shared';
import { describe, expect, it } from 'vitest';

import type { CanonicalRequest } from '../src/canonical-request.ts';
import { crc32, EventStreamDecoder } from '../src/codecs/kiro-eventstream.ts';
import { decodeKiroResponse, encodeKiroRequest, kiroError } from '../src/codecs/kiro.ts';
import { createKiroStreamDecoder } from '../src/codecs/kiro.ts';
import type { CodecContext } from '../src/codecs/types.ts';

/**
 * kiro's wire: the framing, the request, and the stream (C4.6).
 *
 * Two things here are worth more than the rest, because they are the two that
 * cannot be checked by reading the code.
 *
 * **The framing is binary and hand-built in these tests.** A fixture produced by
 * the decoder under test would prove only that it is self-consistent, so every
 * frame below is assembled from the format's own rules — lengths, CRCs, a string
 * header, a JSON payload — and the decoder has to agree with that. The CRC vector
 * is the standard one, which is how the table itself is known to be right.
 *
 * **A frame split across chunks is the normal case, not the edge case.** A body
 * arrives in whatever sizes the socket hands over, so the tests feed one frame in
 * pieces and require the decoder to hold the tail rather than fail on it.
 */

const ids = createIdFactory((bytes) => new Uint8Array(bytes));

function context(account: Readonly<Record<string, string>> = {}): CodecContext {
  return { now: () => 1_700_000_000, ids, model: 'auto', account };
}

/** One AWS EventStream frame, built to the format's own rules. */
function frame(eventType: string, payload: unknown, options: { messageType?: string } = {}): Uint8Array {
  const encoder = new TextEncoder();
  const headers: number[] = [];

  const addHeader = (name: string, value: string): void => {
    const nameBytes = encoder.encode(name);
    const valueBytes = encoder.encode(value);
    headers.push(nameBytes.length, ...nameBytes, 7, (valueBytes.length >> 8) & 0xff, valueBytes.length & 0xff, ...valueBytes);
  };

  addHeader(':event-type', eventType);
  if (options.messageType !== undefined) addHeader(':message-type', options.messageType);

  const body = encoder.encode(JSON.stringify(payload));
  const total = 12 + headers.length + body.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  view.setUint32(0, total);
  view.setUint32(4, headers.length);
  out.set(headers, 12);
  out.set(body, 12 + headers.length);
  view.setUint32(8, crc32(out.subarray(0, 8)));
  view.setUint32(total - 4, crc32(out.subarray(0, total - 4)));
  return out;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe('the CRC the framing is built on', () => {
  it('matches the standard vector', () => {
    // The check value every CRC-32 implementation is known by. If the table were
    // wrong, this is the test that says so rather than a decoder that silently
    // walks off the end of a frame.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
});

describe('decoding frames', () => {
  it('reads the event type and the payload out of one frame', () => {
    const frames = new EventStreamDecoder().push(
      frame('assistantResponseEvent', { content: 'hi' }),
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]?.eventType).toBe('assistantResponseEvent');
    expect(frames[0]?.payload).toEqual({ content: 'hi' });
  });

  it('reads several frames out of one chunk', () => {
    const bytes = concat(
      frame('assistantResponseEvent', { content: 'a' }),
      frame('assistantResponseEvent', { content: 'b' }),
      frame('meteringEvent', { usage: { inputTokens: 1, outputTokens: 2 } }),
    );

    const frames = new EventStreamDecoder().push(bytes);

    expect(frames.map((entry) => entry.eventType)).toEqual([
      'assistantResponseEvent',
      'assistantResponseEvent',
      'meteringEvent',
    ]);
  });

  it('holds a frame that arrives in pieces and completes it on the last', () => {
    // The case a body actually arrives in. A decoder that needed a whole frame
    // per chunk would lose the first event of most responses.
    const bytes = frame('assistantResponseEvent', { content: 'hello' });
    const decoder = new EventStreamDecoder();

    const head = decoder.push(bytes.subarray(0, 6));
    expect(head).toEqual([]);
    expect(decoder.pending).toBe(6);

    const tail = decoder.push(bytes.subarray(6));
    expect(tail).toHaveLength(1);
    expect(tail[0]?.payload).toEqual({ content: 'hello' });
    expect(decoder.pending).toBe(0);
  });

  it('holds a frame whose length has not arrived yet', () => {
    const bytes = frame('assistantResponseEvent', { content: 'x' });
    const decoder = new EventStreamDecoder();

    // Two bytes: not even the total length. Nothing can be concluded, and the
    // decoder says so by returning nothing rather than by guessing.
    expect(decoder.push(bytes.subarray(0, 2))).toEqual([]);
    expect(decoder.push(bytes.subarray(2))).toHaveLength(1);
  });

  it('leaves a truncated frame alone rather than inventing one', () => {
    const bytes = frame('assistantResponseEvent', { content: 'x' });
    const decoder = new EventStreamDecoder();

    expect(decoder.push(bytes.subarray(0, bytes.length - 3))).toEqual([]);
    // The tail is still held: a stream that continues can still complete it.
    expect(decoder.pending).toBe(bytes.length - 3);
  });

  it('carries the message type, which is how an error is told from an event', () => {
    const frames = new EventStreamDecoder().push(
      frame('error', { message: 'nope' }, { messageType: 'error' }),
    );
    expect(frames[0]?.messageType).toBe('error');
  });
});

describe('the request', () => {
  const request: CanonicalRequest = {
    model: 'auto',
    system: [{ type: 'text', text: 'be brief' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first' }], name: null, toolCallId: null },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }], name: null, toolCallId: null },
      { role: 'user', content: [{ type: 'text', text: 'second' }], name: null, toolCallId: null },
    ],
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
    stream: true,
    extras: {},
  };

  it('carries the account profile in the path and the body', () => {
    // Both, because the runtime reads the query for routing and the body for
    // authorisation, and a request with only one is refused.
    const encoded = encodeKiroRequest(request, context({ profileArn: 'arn:aws:kiro::p/one' }));

    expect(encoded.path).toContain('profileArn=arn%3Aaws%3Akiro%3A%3Ap%2Fone');
    expect((encoded.body as { profileArn?: string }).profileArn).toBe('arn:aws:kiro::p/one');
  });

  it('omits the profile when the account has none, rather than sending an empty one', () => {
    const encoded = encodeKiroRequest(request, context());
    expect(encoded.path).toBe('/generateAssistantResponse');
    expect((encoded.body as { profileArn?: string }).profileArn).toBeUndefined();
  });

  it('sends the last turn as the message and everything before it as history', () => {
    const encoded = encodeKiroRequest(request, context({ profileArn: 'arn' }));
    const state = (encoded.body as { conversationState: Record<string, unknown> })
      .conversationState;
    const current = state['currentMessage'] as { userInputMessage: { content: string } };
    const history = state['history'] as Record<string, unknown>[];

    expect(history).toHaveLength(2);
    // The system prompt rides on the turn being asked, because this wire has no
    // field of its own for one.
    expect(current.userInputMessage.content).toBe('be brief\n\nsecond');
    expect(history[0]).toHaveProperty('userInputMessage');
    expect(history[1]).toHaveProperty('assistantResponseMessage');
  });

  it('sends the model the client asked for, not a mapped stand-in', () => {
    const encoded = encodeKiroRequest({ ...request, model: 'glm-5' }, context({ profileArn: 'arn' }));
    const state = (encoded.body as { conversationState: Record<string, unknown> })
      .conversationState;
    const current = state['currentMessage'] as { userInputMessage: { modelId: string } };
    expect(current.userInputMessage.modelId).toBe('glm-5');
  });
});

describe('the stream', () => {
  it('opens, emits the text, and finishes with the usage the metering event carried', () => {
    const decoder = createKiroStreamDecoder(context());
    const events = decoder.push(
      concat(
        frame('assistantResponseEvent', { content: 'hel' }),
        frame('assistantResponseEvent', { content: 'lo' }),
        frame('meteringEvent', { usage: { inputTokens: 4, outputTokens: 2 } }),
      ),
    );
    const all = [...events, ...decoder.flush()];

    expect(all.filter((event) => event.type === 'text_delta').map((event) => event.text)).toEqual([
      'hel',
      'lo',
    ]);
    const finish = all.find((event) => event.type === 'finish');
    expect(finish).toMatchObject({
      finishReason: 'stop',
      usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
    });
  });

  it('reports a failure frame as an error rather than as text', () => {
    const decoder = createKiroStreamDecoder(context());
    const events = decoder.push(
      frame('error', { message: 'suspended' }, { messageType: 'error' }),
    );

    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.some((event) => event.type === 'text_delta')).toBe(false);
  });

  it('assembles a tool call from the frames it was spread across', () => {
    const decoder = createKiroStreamDecoder(context());
    const events = decoder.push(
      concat(
        frame('toolUseEvent', { toolUseId: 't1', name: 'lookup' }),
        frame('toolUseEvent', { toolUseId: 't1', input: '{"city":' }),
        frame('toolUseEvent', { toolUseId: 't1', input: '"oslo"}' }),
      ),
    );
    const all = [...events, ...decoder.flush()];

    const start = all.find((event) => event.type === 'block_start');
    expect(start).toMatchObject({ block: { type: 'tool_use', id: 't1', name: 'lookup' } });
    expect(all.filter((event) => event.type === 'input_json_delta').map((e) => e.partialJson).join('')).toBe(
      '{"city":"oslo"}',
    );
    expect(all.find((event) => event.type === 'finish')).toMatchObject({
      finishReason: 'tool_calls',
    });
  });
});

describe('a whole answer', () => {
  it('reads text and usage out of the same framing', () => {
    const result = decodeKiroResponse(
      concat(
        frame('assistantResponseEvent', { content: 'hello' }),
        frame('meteringEvent', { usage: { inputTokens: 3, outputTokens: 1 } }),
      ),
      context(),
    );

    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(result.usage.totalTokens).toBe(4);
    expect(result.finishReason).toBe('stop');
  });

  it('throws on an error frame rather than answering with an empty turn', () => {
    expect(() =>
      decodeKiroResponse(frame('error', { message: 'nope' }, { messageType: 'error' }), context()),
    ).toThrow(/nope/u);
  });
});

describe('a failed request', () => {
  it('reads the reason out of the body and the kind out of the status', () => {
    // The shape a suspended account actually answered with.
    const error = kiroError({
      status: 403,
      body: { message: 'Your User ID is temporarily suspended.', reason: 'TEMPORARILY_SUSPENDED' },
      retryAfterSeconds: null,
    });

    expect(error.message).toBe('Your User ID is temporarily suspended.');
    expect(error.kind).toBe('permission');
  });

  it('falls back to the status when the body carries nothing readable', () => {
    const error = kiroError({ status: 503, body: '', retryAfterSeconds: 5 });
    expect(error.kind).toBe('unavailable');
    expect(error.retryAfterSeconds).toBe(5);
  });
});
