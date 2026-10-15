import { HttpResponse, delay } from 'msw';

/**
 * Server-sent events, written by hand because one mock route needs them.
 *
 * The chat turn is the only route in the console whose answer arrives while it
 * is still being written. `POST /chat/sessions/:id/messages` replies with
 * `text/event-stream`, and the frames on it are AI SDK UI Message chunks — the
 * same bytes FASE C's Hono handler will emit, so the page is built against the
 * real protocol rather than a stand-in that has to be swapped out later.
 *
 * The pacing is the point of having this at all. A reply that lands in one tick
 * cannot show a streaming renderer working, cannot show a thinking block filling
 * in, and cannot show a stop button that stops anything, so each frame is held
 * back by the caller's own delay.
 */

/** One frame, and how long to wait before writing it. */
export interface SseBeat {
  /** Milliseconds to hold before this frame. The first one is the time to first byte. */
  readonly after: number;
  readonly chunk: unknown;
}

const DONE = 'data: [DONE]\n\n';

function frame(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * `onDone` runs once the last frame is on the wire — the point at which the
 * turn is real and a handler can persist it without racing the client.
 */
export function sseResponse(beats: readonly SseBeat[], onDone?: () => void): HttpResponse<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const beat of beats) {
          if (beat.after > 0) await delay(beat.after);
          controller.enqueue(encoder.encode(frame(beat.chunk)));
        }
        controller.enqueue(encoder.encode(DONE));
      } catch {
        // The reader went away mid-turn — a stopped reply, or a page that
        // navigated. Nothing is left to write to and closing would throw too.
        return;
      }
      controller.close();
      onDone?.();
    },
  });

  return new HttpResponse(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

/**
 * Break text into the pieces a model would actually emit.
 *
 * Words with their trailing space, so the reassembled text is byte-identical to
 * the input. Splitting on characters would look wrong — no real model streams a
 * letter at a time — and splitting on sentences would not stream at all.
 */
export function words(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}
