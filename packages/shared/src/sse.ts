/**
 * Server-sent events, encoded and decoded.
 *
 * One framing rule is all every SSE client agrees on: a frame is a run of
 * `field: value` lines ended by a blank line. `event:` names the frame and
 * `data:` carries its payload; a line beginning with `:` is a comment, which is
 * what makes a comment the only thing a client will read and ignore — so that is
 * what a heartbeat is.
 *
 * The decoder buffers rather than splitting each chunk on `\n\n`, because a chunk
 * off a socket boundary lands mid-frame. The split has to happen on the buffer,
 * and the tail has to survive to the next call, or the first frame after every
 * boundary is lost.
 */

export interface SseFrame {
  /** The `event:` name, or null when the frame did not name one. */
  readonly event: string | null;
  /** The `data:` payload; multiple `data:` lines are joined with newlines. */
  readonly data: string;
}

export interface SseDecoder {
  /** Feed a chunk; returns every frame the chunk completed. */
  push(chunk: string): readonly SseFrame[];
  /** Whatever the buffer still holds once the stream ends. */
  flush(): readonly SseFrame[];
}

/**
 * One frame, ready to write.
 *
 * A payload containing newlines becomes several `data:` lines, which is the only
 * way SSE carries a newline — and the decoder joins them back, so the pair
 * round-trips.
 */
export function sseFrame(frame: { readonly event?: string; readonly data: string }): string {
  const lines: string[] = [];
  if (frame.event !== undefined) lines.push(`event: ${frame.event}`);
  for (const line of frame.data.split('\n')) lines.push(`data: ${line}`);
  return `${lines.join('\n')}\n\n`;
}

/** A comment frame, for a heartbeat: clients read it and drop it. */
export function sseComment(text: string): string {
  return `: ${text}\n\n`;
}

function parseFrame(raw: string): SseFrame | null {
  let event: string | null = null;
  const data: string[] = [];

  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  // A frame of nothing but comments carries no payload; callers never want it.
  if (event === null && data.length === 0) return null;
  return { event, data: data.join('\n') };
}

/**
 * The same decoder, fed bytes instead of text.
 *
 * **The boundary belongs here rather than in the transport.** A body arrives as
 * bytes and only the codec knows what they mean: every SSE provider's is UTF-8
 * text, but not every provider's body is SSE — AWS EventStream, which one wire in
 * the catalogue speaks, is length-prefixed binary and is destroyed by a UTF-8
 * decode. So the transport hands bytes down and each codec decodes its own, which
 * is why this adapter exists rather than a single decode in the pump.
 *
 * `{ stream: true }` is what makes it correct across a chunk boundary: a
 * multi-byte character split between two reads is held until its remaining bytes
 * arrive instead of becoming a replacement character. `flush` releases the last
 * bytes and then whatever frame they completed.
 */
export interface ByteSseDecoder {
  push(chunk: Uint8Array): readonly SseFrame[];
  flush(): readonly SseFrame[];
}

export function createUtf8SseDecoder(): ByteSseDecoder {
  const text = new TextDecoder();
  const sse = createSseDecoder();

  return {
    push(chunk) {
      return sse.push(text.decode(chunk, { stream: true }));
    },
    flush() {
      // The trailing `decode()` with no argument is what releases a held
      // multi-byte tail; the bytes it produces can complete the frame the buffer
      // was holding, so they go through `push` before the frame-level flush.
      return [...sse.push(text.decode()), ...sse.flush()];
    },
  };
}

export function createSseDecoder(): SseDecoder {
  let buffer = '';

  return {
    push(chunk) {
      // Normalise CRLF and a lone CR so the frame separator is always `\n\n`.
      buffer += chunk.replace(/\r\n?/g, '\n');

      const frames: SseFrame[] = [];
      for (;;) {
        const split = buffer.indexOf('\n\n');
        if (split === -1) break;
        const raw = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const frame = parseFrame(raw);
        if (frame !== null) frames.push(frame);
      }
      return frames;
    },

    flush() {
      const rest = buffer;
      buffer = '';
      if (rest.trim() === '') return [];
      const frame = parseFrame(rest);
      return frame === null ? [] : [frame];
    },
  };
}
