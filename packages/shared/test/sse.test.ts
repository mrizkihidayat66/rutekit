import { describe, expect, it } from 'vitest';

import { createSseDecoder, sseComment, sseFrame } from '../src/sse.ts';

/**
 * SSE framing, both directions.
 *
 * The decoder is the half that earns the tests: an encoder can only be wrong in
 * ways a reader would see immediately, while a decoder is wrong exactly where a
 * socket boundary falls — which is to say, not on the machine that wrote it.
 */

describe('sseFrame', () => {
  it('names the frame when it has an event', () => {
    expect(sseFrame({ event: 'message_start', data: '{"a":1}' })).toBe(
      'event: message_start\ndata: {"a":1}\n\n',
    );
  });

  it('omits the event line for an unnamed frame', () => {
    expect(sseFrame({ data: '[DONE]' })).toBe('data: [DONE]\n\n');
  });

  it('splits a payload containing newlines across data lines', () => {
    expect(sseFrame({ data: 'one\ntwo' })).toBe('data: one\ndata: two\n\n');
  });
});

describe('sseComment', () => {
  it('writes a comment frame, which clients drop', () => {
    expect(sseComment('keep-alive')).toBe(': keep-alive\n\n');
  });
});

describe('createSseDecoder', () => {
  it('reads one frame out of one chunk', () => {
    const decoder = createSseDecoder();
    expect(decoder.push('data: {"a":1}\n\n')).toEqual([{ event: null, data: '{"a":1}' }]);
  });

  it('reads several frames out of one chunk', () => {
    const decoder = createSseDecoder();
    const frames = decoder.push('data: 1\n\ndata: 2\n\ndata: 3\n\n');
    expect(frames.map((frame) => frame.data)).toEqual(['1', '2', '3']);
  });

  it('holds a frame that arrives split across chunks', () => {
    const decoder = createSseDecoder();

    expect(decoder.push('event: message_start\nda')).toEqual([]);
    expect(decoder.push('ta: {"type":"message_start"}')).toEqual([]);
    expect(decoder.push('\n\n')).toEqual([
      { event: 'message_start', data: '{"type":"message_start"}' },
    ]);
  });

  it('holds a frame split between its separator and the next frame', () => {
    const decoder = createSseDecoder();

    // The blank line itself is split, so neither call sees `\n\n` on its own.
    expect(decoder.push('data: one\n')).toEqual([]);
    expect(decoder.push('\ndata: two\n\n')).toEqual([
      { event: null, data: 'one' },
      { event: null, data: 'two' },
    ]);
  });

  it('joins multiple data lines with newlines', () => {
    const decoder = createSseDecoder();
    expect(decoder.push('data: one\ndata: two\n\n')).toEqual([{ event: null, data: 'one\ntwo' }]);
  });

  it('ignores a comment frame, heartbeat or not', () => {
    const decoder = createSseDecoder();
    expect(decoder.push(': keep-alive\n\n')).toEqual([]);
    expect(decoder.push('data: real\n\n')).toEqual([{ event: null, data: 'real' }]);
  });

  it('ignores a comment that shares a frame with a payload', () => {
    const decoder = createSseDecoder();
    expect(decoder.push(': note\nevent: ping\ndata: {}\n\n')).toEqual([
      { event: 'ping', data: '{}' },
    ]);
  });

  it('strips the one optional space after the colon, and no more', () => {
    const decoder = createSseDecoder();
    expect(decoder.push('data:  spaced\n\n')).toEqual([{ event: null, data: ' spaced' }]);
    expect(decoder.push('data:spaced\n\n')).toEqual([{ event: null, data: 'spaced' }]);
  });

  it('treats CRLF the way the spec allows', () => {
    const decoder = createSseDecoder();
    expect(decoder.push('event: ping\r\ndata: {}\r\n\r\n')).toEqual([
      { event: 'ping', data: '{}' },
    ]);
  });

  it('round-trips what the encoder wrote', () => {
    const decoder = createSseDecoder();
    const written = sseFrame({ event: 'content_block_delta', data: 'line one\nline two' });
    expect(decoder.push(written)).toEqual([
      { event: 'content_block_delta', data: 'line one\nline two' },
    ]);
  });

  it('flushes a final frame the stream ended without terminating', () => {
    const decoder = createSseDecoder();
    expect(decoder.push('data: last')).toEqual([]);
    expect(decoder.flush()).toEqual([{ event: null, data: 'last' }]);
    expect(decoder.flush()).toEqual([]);
  });

  it('flushes nothing when the buffer holds only whitespace', () => {
    const decoder = createSseDecoder();
    decoder.push('data: one\n\n   ');
    expect(decoder.flush()).toEqual([]);
  });
});
