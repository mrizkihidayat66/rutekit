import type { WireFamily } from '@contracts';

import { anthropicError, decodeAnthropicResponse, encodeAnthropicRequest } from './anthropic.ts';
import { createAnthropicStreamDecoder } from './anthropic-stream.ts';
import { decodeGoogleResponse, encodeGoogleRequest, googleError } from './google.ts';
import { createGoogleStreamDecoder } from './google-stream.ts';
import { decodeOpenAiResponse, encodeOpenAiRequest, openAiError } from './openai.ts';
import { createOpenAiStreamDecoder } from './openai-stream.ts';
import type { WireCodec } from './types.ts';

/**
 * The four translations of one wire family, assembled.
 *
 * A codec is built here rather than inside its own family module because the
 * stream decoder needs the family's request/response helpers, and the family
 * module would otherwise have to import the decoder back — a cycle that buys
 * nothing. Keeping the assembly in one place also makes the set of families
 * visible in a single screen.
 */
export const openAiCodec: WireCodec = {
  encodeRequest: encodeOpenAiRequest,
  decodeResponse: decodeOpenAiResponse,
  createStreamDecoder: createOpenAiStreamDecoder,
  decodeError: openAiError,
};

export const anthropicCodec: WireCodec = {
  encodeRequest: encodeAnthropicRequest,
  decodeResponse: decodeAnthropicResponse,
  createStreamDecoder: createAnthropicStreamDecoder,
  decodeError: anthropicError,
};

export const googleCodec: WireCodec = {
  encodeRequest: encodeGoogleRequest,
  decodeResponse: decodeGoogleResponse,
  createStreamDecoder: createGoogleStreamDecoder,
  decodeError: googleError,
};

/**
 * The codec for a family, or null when there is none.
 *
 * `custom` is deliberately absent rather than defaulting to the OpenAI codec. A
 * provider whose wire rutekit does not know cannot be reached through `/v1` at
 * all — only probed — and pretending otherwise would send a request shaped for
 * the wrong API and report the provider's confusion as an error of its own.
 */
export function codecFor(family: WireFamily): WireCodec | null {
  switch (family) {
    case 'openai':
      return openAiCodec;
    case 'anthropic':
      return anthropicCodec;
    case 'google':
      return googleCodec;
    case 'custom':
      return null;
  }
}

export * from './blocks.ts';
export * from './shared.ts';
export * from './types.ts';
