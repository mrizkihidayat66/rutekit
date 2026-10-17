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
  /**
   * The account's own fields, as name/value strings.
   *
   * **Some providers need a value out of the credential in the request body, not
   * only in a header.** kiro is the case: its runtime refuses a request without a
   * `profileArn`, which is issued alongside the token and travels in the JSON
   * body as well as the query string. The pivot has no field for it and should
   * not grow one — it is not a property of the conversation — so the account's
   * values are handed to the codec, which is the only thing that knows where its
   * own wire wants them.
   *
   * Empty when the credential is opaque (an API key, a cookie): a value that does
   * not parse as a JSON object has no named fields to offer.
   */
  readonly account: Readonly<Record<string, string>>;
  /**
   * The cryptographic primitives this package cannot compute.
   *
   * **Injected rather than imported, and not only for tidiness.** This package is
   * pure — nothing in it reaches for `node:*` — which is what lets the same
   * translation run in a browser, in a test, and in the server. A wire that signs
   * its requests needs primitives that are not arithmetic: MD5, RSA and AES.
   * Those arrive through this port, so the codec stays testable against a
   * deterministic stand-in while the server supplies the real thing.
   *
   * Base64 is deliberately *not* here: it is arithmetic, and the codec that needs
   * it implements it rather than widening the port.
   */
  readonly crypto: CryptoPort;
}

/**
 * What a signing codec needs from the platform.
 *
 * Three primitives, each named for what the wire does with it rather than for the
 * algorithm alone — `rsaEncryptPkcs1` says which padding, because that is the
 * part a provider notices when it is wrong.
 */
export interface CryptoPort {
  /** MD5, hex-encoded. A signature primitive, not a security one. */
  md5Hex(text: string): string;
  /** RSA encryption with PKCS#1 v1.5 padding, against a PEM public key. */
  rsaEncryptPkcs1(publicKeyPem: string, data: Uint8Array): Uint8Array;
  /** AES-CBC. The caller passes the IV, because one wire uses the key as its own. */
  aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array;
}

/** A body ready for the wire, and the path it belongs on. */
export interface EncodedRequest {
  /**
   * The codec's default path, relative to the provider's base URL. A manifest
   * that names its own `chatPath` overrides it, because the manifest is what
   * knows a provider that mounted the same API somewhere unexpected.
   */
  readonly path: string;
  /**
   * The request body.
   *
   * A string as well as an object, because a wire may want its body encoded
   * rather than serialised: qoder's is a JSON document run through a signing
   * step and then re-encoded, so what leaves is not `JSON.stringify` of anything
   * the pivot holds. Handing the transport an already-encoded string is the only
   * way to express that without teaching every caller a provider's codec.
   */
  readonly body: Record<string, unknown> | string;
  /**
   * Headers this wire needs that no other layer can produce.
   *
   * Most providers are authenticated by one header, which the manifest describes
   * and `applyAuth` writes. A signed request is not: qoder sends a date, a
   * session key, a client type and a signature derived from all of them, and
   * those are the codec's own arithmetic. Merged over the manifest's and the
   * credential's, so a codec can override a default rather than fight it.
   */
  readonly headers?: Readonly<Record<string, string>>;
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
  /**
   * Bytes, not text — and the codec decodes them.
   *
   * A body arrives as bytes and only the codec knows what they mean. Every SSE
   * provider's body is UTF-8 text, but not every provider's is SSE: AWS
   * EventStream is length-prefixed binary and a UTF-8 decode destroys it. Putting
   * the decode in the transport would mean one wire family could never be
   * expressed, so the transport hands bytes down and each codec owns its own
   * boundary — the text ones through `createUtf8SseDecoder`.
   */
  push(chunk: Uint8Array): readonly CanonicalStreamEvent[];
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
  /**
   * The pivot, rendered into this family's request body.
   *
   * The context is here for the same reason it is on the decoders: a provider
   * whose request needs a value out of the credential — kiro's `profileArn` — has
   * nowhere else to read it. A codec that does not need it simply declares the
   * one parameter, which is what the three SSE families do.
   */
  encodeRequest(request: CanonicalRequest, context: CodecContext): EncodedRequest;
  /**
   * A non-streaming answer, decoded into the pivot.
   *
   * Bytes, for the same reason the stream decoder takes bytes: only the codec
   * knows whether its provider answers JSON or a binary framing.
   */
  decodeResponse(body: Uint8Array, context: CodecContext): CanonicalResult;
  /** A streaming answer, decoded incrementally into the pivot. */
  createStreamDecoder(context: CodecContext): StreamDecoder;
  /** A failed answer, decoded into the one error shape every surface returns. */
  decodeError(input: ErrorInput): ApiError;
}
