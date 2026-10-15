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
