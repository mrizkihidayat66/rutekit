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

export function createIdFactory(random: RandomSource, length = 24): IdFactory {
  const make = (prefix: string): string => `${prefix}${randomToken(random, length)}`;
  return {
    chatCompletion: () => make('chatcmpl-'),
    message: () => make('msg_'),
    response: () => make('resp_'),
    completion: () => make('cmpl-'),
    toolCall: () => make('call_'),
    opaque: () => randomToken(random, length),
  };
}
