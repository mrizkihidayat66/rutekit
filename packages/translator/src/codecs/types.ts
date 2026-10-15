import type { ApiError } from '@contracts';
import type { IdFactory } from '@shared';

import type { CanonicalRequest } from '../canonical-request.ts';
import type { CanonicalResult } from '../canonical-result.ts';
import type { CanonicalStreamEvent } from '../canonical-stream.ts';

/**
 * What a codec needs that the request itself does not carry.
 *
 * The clock and the id factory are arguments for the same reason the rest of this
 * package takes them: a codec that reached for `Date` or `crypto` could not be
 * driven against a fixed stream. Both are genuinely needed — Google reports
 * neither an id nor a creation time, so a result built from a Google body has to
 * be given one of each, and a synthesised id has to look like the dialect the
 * client is reading.
 *
 * `model` is the id the client asked for. It is the only name available when a
 * provider answers without echoing one, which Google also does.
 */
export interface CodecContext {
  /** Unix seconds. */
  readonly now: () => number;
  readonly ids: IdFactory;
  readonly model: string;
}

/** A body ready for the wire, and the path it belongs on. */
export interface EncodedRequest {
  /**
   * The codec's default path, relative to the provider's base URL. A manifest
   * that names its own `chatPath` overrides it, because the manifest is what
   * knows a provider that mounted the same API somewhere unexpected.
   */
  readonly path: string;
  readonly body: Record<string, unknown>;
}

/**
 * A provider's stream, decoded incrementally.
 *
 * `push` takes whatever text arrived and returns the events it completed; a
 * partial frame stays buffered. `flush` is called once at end of stream, both to
 * release a trailing event the provider never terminated and to close the
 * `finish` a codec was holding until it had the usage to go with it.
 */
export interface StreamDecoder {
  push(chunk: string): readonly CanonicalStreamEvent[];
  flush(): readonly CanonicalStreamEvent[];
}

/** The parts of a failed upstream response a codec reads. */
export interface ErrorInput {
  readonly status: number;
  readonly body: unknown;
  /** Already parsed from `Retry-After`; null when the header was absent. */
  readonly retryAfterSeconds: number | null;
}

/**
 * One wire family's four translations.
 *
 * A codec owns a dialect end to end, so adding a provider that speaks a known
 * family is a manifest and not a code. `custom` has no codec at all, which is the
 * honest answer: a provider whose wire rutekit does not know cannot be reached
 * through `/v1`, only probed.
 */
export interface WireCodec {
  /** The pivot, rendered into this family's request body. */
  encodeRequest(request: CanonicalRequest): EncodedRequest;
  /** A non-streaming answer, decoded into the pivot. */
  decodeResponse(body: unknown, context: CodecContext): CanonicalResult;
  /** A streaming answer, decoded incrementally into the pivot. */
  createStreamDecoder(context: CodecContext): StreamDecoder;
  /** A failed answer, decoded into the one error shape every surface returns. */
  decodeError(input: ErrorInput): ApiError;
}
