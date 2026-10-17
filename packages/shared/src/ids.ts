/**
 * Request identifiers, generated from a random source the caller supplies.
 *
 * There is no global `crypto` here on purpose. This package declares `types: []`
 * and reaches for no ambient global — the same discipline the provider registry
 * follows — so the server passes `(n) => crypto.getRandomValues(new Uint8Array(n))`
 * and a test passes a counter. That is also what makes an id reproducible in a
 * test rather than something only asserted by shape.
 *
 * The prefixes are the ones the dialects actually use: an OpenAI client recognises
 * `chatcmpl-`, an Anthropic client `msg_`. They are generated rather than taken
 * from upstream only when upstream gave none.
 */

export type RandomSource = (bytes: number) => Uint8Array;

export interface IdFactory {
  chatCompletion(): string;
  message(): string;
  response(): string;
  completion(): string;
  toolCall(): string;
  /** An id with no dialect-specific prefix. */
  opaque(): string;
  /**
   * A UUID v4.
   *
   * A wire that types a field as a UUID rejects anything else — kiro answers
   * `REQUEST_BODY_INVALID` for its `agentContinuationId` when handed an opaque
   * token, which reads as "your request is malformed" rather than "that field has
   * the wrong shape". Generating one from the same random source keeps this
   * package free of `crypto` and keeps the value reproducible in a test.
   */
  uuid(): string;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomToken(random: RandomSource, length: number): string {
  const bytes = random(length);
  let out = '';
  for (let index = 0; index < length; index += 1) {
    // `?? 0` because `noUncheckedIndexedAccess` cannot know the source honoured
    // the length it was asked for.
    out += ALPHABET[(bytes[index] ?? 0) % ALPHABET.length];
  }
  return out;
}

/** RFC 4122 version 4, from 16 random bytes — the two version bits set, the variant bits cleared. */
function uuidFrom(random: RandomSource): string {
  const bytes = random(16);
  const hex: string[] = [];
  for (let index = 0; index < 16; index += 1) {
    let byte = bytes[index] ?? 0;
    if (index === 6) byte = (byte & 0x0f) | 0x40;
    if (index === 8) byte = (byte & 0x3f) | 0x80;
    hex.push(byte.toString(16).padStart(2, '0'));
  }
  const joined = hex.join('');
  return [
    joined.slice(0, 8),
    joined.slice(8, 12),
    joined.slice(12, 16),
    joined.slice(16, 20),
    joined.slice(20),
  ].join('-');
}

export function createIdFactory(random: RandomSource, length = 24): IdFactory {
  const make = (prefix: string): string => `${prefix}${randomToken(random, length)}`;
  return {
    chatCompletion: () => make('chatcmpl-'),
    message: () => make('msg_'),
    response: () => make('resp_'),
    completion: () => make('cmpl-'),
    toolCall: () => make('call_'),
    opaque: () => randomToken(random, length),
    uuid: () => uuidFrom(random),
  };
}
