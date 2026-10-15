import { describe, expect, it } from 'vitest';

import { createIdFactory, type RandomSource } from '../src/ids.ts';

/**
 * The id factory, driven by a counter so the output is a value rather than a
 * shape. That is the point of injecting the source: "looks random" is not
 * something a test can assert.
 */

/** Bytes that are simply the sequence 0, 1, 2, … so an id is predictable. */
function counting(): RandomSource {
  let next = 0;
  return (bytes) => {
    const out = new Uint8Array(bytes);
    for (let index = 0; index < bytes; index += 1) out[index] = next++;
    return out;
  };
}

/** Bytes that are all the same, so every character of an id is identical. */
function constant(value: number): RandomSource {
  return (bytes) => new Uint8Array(bytes).fill(value);
}

describe('createIdFactory', () => {
  it('prefixes each dialect the way that dialect does', () => {
    const ids = createIdFactory(constant(0), 8);
    expect(ids.chatCompletion()).toBe('chatcmpl-aaaaaaaa');
    expect(ids.message()).toBe('msg_aaaaaaaa');
    expect(ids.response()).toBe('resp_aaaaaaaa');
    expect(ids.completion()).toBe('cmpl-aaaaaaaa');
    expect(ids.toolCall()).toBe('call_aaaaaaaa');
    expect(ids.opaque()).toBe('aaaaaaaa');
  });

  it('advances with the source, so two ids differ', () => {
    const ids = createIdFactory(counting(), 6);
    expect(ids.opaque()).toBe('abcdef');
    expect(ids.opaque()).toBe('ghijkl');
  });

  it('honours the requested length', () => {
    expect(createIdFactory(constant(0), 4).opaque()).toHaveLength(4);
    expect(createIdFactory(constant(0)).opaque()).toHaveLength(24);
  });

  it('survives a source that returns fewer bytes than it was asked for', () => {
    // `noUncheckedIndexedAccess` makes this a real branch rather than a
    // theoretical one, so it is asserted rather than assumed.
    const short: RandomSource = () => new Uint8Array(2);
    expect(createIdFactory(short, 6).opaque()).toBe('aaaaaa');
  });
});
