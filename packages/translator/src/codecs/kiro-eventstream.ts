/**
 * AWS EventStream framing, for the one wire whose body is not text.
 *
 * **This file exists because a body is not always UTF-8.** Every other provider
 * in the catalogue answers `text/event-stream`: newline-delimited, readable as it
 * arrives. kiro's runtime answers AWS EventStream, which is a length-prefixed
 * binary framing — a total length, a header length, a CRC, the headers, the
 * payload, and a CRC — so decoding it as text first destroys it, and the failure
 * looks like a provider sending nonsense rather than like a missing decoder.
 *
 * The format is public and stable (it is how AWS's streaming APIs frame events):
 *
 *   | offset      | bytes | what                          |
 *   | ----------- | ----- | ----------------------------- |
 *   | 0           | 4     | total length, big-endian      |
 *   | 4           | 4     | headers length, big-endian    |
 *   | 8           | 4     | CRC32 of bytes 0..8           |
 *   | 12          | h     | headers                       |
 *   | 12 + h      | rest  | payload, usually JSON         |
 *   | total - 4   | 4     | CRC32 of everything before it |
 *
 * A header is a length-prefixed name, a one-byte type, and a length-prefixed
 * value. Only type 7 (string) carries anything this needs, and what it carries is
 * `:event-type` — the name that says whether the payload is assistant text, a
 * tool call, or the usage report.
 *
 * **The decoder is incremental**, because a frame arrives split across chunks as
 * often as not. `push` returns what it completed and holds the tail; a one-shot
 * decoder would drop the first event of most responses.
 */

/** The CRC-32 table, built once. IEEE 802.3, which is what EventStream uses. */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** One decoded frame: what it is, and what it carries. */
export interface EventStreamFrame {
  /** The `:event-type` header, or null when the frame carries none. */
  readonly eventType: string | null;
  /** `:message-type` — `event`, `error` or `exception`. */
  readonly messageType: string | null;
  /** The payload, parsed when it is JSON and left as text when it is not. */
  readonly payload: unknown;
  /** The payload as text, for a caller that wants the raw bytes' meaning. */
  readonly payloadText: string;
}

const PRELUDE_BYTES = 12;
const TRAILER_BYTES = 4;
const MIN_FRAME_BYTES = PRELUDE_BYTES + TRAILER_BYTES;

/** A header value's type byte. Only `string` carries anything read here. */
const HEADER_TYPE_STRING = 7;

function readUint32(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] as number) << 24) |
      ((bytes[at + 1] as number) << 16) |
      ((bytes[at + 2] as number) << 8) |
      (bytes[at + 3] as number)) >>>
    0
  );
}

function readUint16(bytes: Uint8Array, at: number): number {
  return ((bytes[at] as number) << 8) | (bytes[at + 1] as number);
}

const TEXT = new TextDecoder();

/** The headers of one frame, as name/value pairs. */
function readHeaders(bytes: Uint8Array, from: number, length: number): Map<string, string> {
  const headers = new Map<string, string>();
  let at = from;
  const end = from + length;

  while (at < end) {
    const nameLength = bytes[at] as number;
    at += 1;
    const name = TEXT.decode(bytes.subarray(at, at + nameLength));
    at += nameLength;

    const type = bytes[at] as number;
    at += 1;
    if (type !== HEADER_TYPE_STRING) {
      // A non-string header (a timestamp, a uuid) is where this walk stops rather
      // than guesses: its width depends on its type, and a wrong guess would
      // desynchronise every header after it.
      break;
    }

    const valueLength = readUint16(bytes, at);
    at += 2;
    headers.set(name, TEXT.decode(bytes.subarray(at, at + valueLength)));
    at += valueLength;
  }

  return headers;
}

export class EventStreamDecoder {
  #buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): readonly EventStreamFrame[] {
    if (chunk.length > 0) {
      const merged = new Uint8Array(this.#buffer.length + chunk.length);
      merged.set(this.#buffer, 0);
      merged.set(chunk, this.#buffer.length);
      this.#buffer = merged;
    }

    const frames: EventStreamFrame[] = [];
    for (;;) {
      const frame = this.#takeOne();
      if (frame === null) break;
      frames.push(frame);
    }
    return frames;
  }

  /** The bytes held back, for a caller that wants to report a truncated stream. */
  get pending(): number {
    return this.#buffer.length;
  }

  #takeOne(): EventStreamFrame | null {
    const bytes = this.#buffer;
    if (bytes.length < MIN_FRAME_BYTES) return null;

    const totalLength = readUint32(bytes, 0);
    const headersLength = readUint32(bytes, 4);

    // A frame claiming less than its own overhead is corrupt, and one longer than
    // what has arrived is incomplete. Both leave the buffer alone: the first
    // because there is nothing sensible to skip to, the second because the rest
    // is still coming.
    if (totalLength < MIN_FRAME_BYTES) return null;
    if (bytes.length < totalLength) return null;

    const frame = bytes.subarray(0, totalLength);
    this.#buffer = bytes.subarray(totalLength);

    const payloadStart = PRELUDE_BYTES + headersLength;
    const payloadEnd = totalLength - TRAILER_BYTES;
    const headers =
      payloadStart <= payloadEnd
        ? readHeaders(frame, PRELUDE_BYTES, headersLength)
        : new Map<string, string>();
    const payloadText = TEXT.decode(frame.subarray(payloadStart, payloadEnd));

    let payload: unknown = payloadText;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      // Not JSON. The caller decides whether that is a problem — a gateway's
      // error frame is often a plain sentence.
    }

    return {
      eventType: headers.get(':event-type') ?? null,
      messageType: headers.get(':message-type') ?? null,
      payload,
      payloadText,
    };
  }
}
