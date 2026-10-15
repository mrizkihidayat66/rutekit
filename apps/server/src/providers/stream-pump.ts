import type { CanonicalStreamEvent, StreamDecoder, StreamRenderer } from '@translator';
import type { ApiError, Usage } from '@contracts';

import { AppError, isAppError } from '@server/errors.ts';

/**
 * Turning an upstream SSE body into the client's stream (C4.6).
 *
 * Two things happen here that the rest of the data plane cannot do later, because
 * by the time they matter the 200 has already gone out.
 *
 * The first is priming. A provider that answers `200` and then says nothing is the
 * failure the three clocks in `config.ts` exist for, and the only moment a timeout
 * can still become a status code is before the response is committed — so the
 * first chunk is read here, under `streamFirstChunkMs`, and a provider that misses
 * that clock is still an error the client reads as one (CONTRIBUTING §5.6).
 *
 * The second is the terminal frame. Once the body is streaming, a failure can no
 * longer change the status, so the stream has to say what happened in its own
 * dialect. The pivot route renders an error event through the same renderer that
 * wrote every frame before it. The direct route has no renderer by design — its
 * whole point is that the provider's bytes are the answer — so it aborts instead,
 * which a client can tell apart from an answer that merely ended.
 */

/** Read the first chunk, or refuse before the response is committed. */
export async function primeFirstChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
  provider: string,
): Promise<Uint8Array> {
  const step = await withTimeout(
    reader.read(),
    ms,
    `${provider} accepted the request but did not start answering in time.`,
  );
  if (step.done) {
    // A 200 with an empty body is not a stream, and there is no first frame to
    // build one from. Saying so now costs a status code; saying it later costs
    // the client a spinner.
    throw AppError.upstreamError(`${provider} answered with an empty body.`, { provider });
  }
  return step.value;
}

export interface PumpInput {
  /** The upstream body, positioned just past the chunk priming already read. */
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  /** The chunk read before the 200 was committed; written out first. */
  readonly first: Uint8Array;
  readonly decoder: StreamDecoder;
  /** Null on the direct route, where the provider's own bytes are the answer. */
  readonly renderer: StreamRenderer | null;
  /** Longest gap allowed between two chunks of a stream that has already started. */
  readonly stallMs: number;
  readonly provider: string;
}

export interface PumpHandlers {
  /**
   * Once, the moment the provider's first bytes are consumed.
   *
   * This is the stream's time-to-first-token (FR-12.3): the gap between the
   * request going out and the provider starting to answer. It is reported from
   * here rather than measured in the caller because this is the only place that
   * knows the difference between "the headers arrived" — which is what commits
   * the 200 — and "the answer started".
   */
  readonly firstChunk?: () => void;
  /** Once, with the usage the provider reported — null when it reported none. */
  readonly finished: (usage: Usage | null) => void;
  /** Once, when the stream ended badly. The response is already committed. */
  readonly failed: (error: unknown) => void;
}

export function pumpStream(input: PumpInput, handlers: PumpHandlers): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = new TextDecoder();

  return new ReadableStream<Uint8Array>({
    async start(controller): Promise<void> {
      let usage: Usage | null = null;
      let sawFirst = false;

      const emit = (events: readonly CanonicalStreamEvent[]): void => {
        for (const event of events) {
          if (event.type === 'finish') usage = event.usage;
          if (input.renderer === null) continue;
          const frame = input.renderer.render(event);
          if (frame !== null) controller.enqueue(encoder.encode(frame));
        }
      };

      /**
       * Whatever the surface writes after the provider's last event.
       *
       * A surface whose dialect has a tail of its own — the AI SDK's `finish` and
       * `[DONE]` — writes it here rather than from the caller, so it lands before
       * `finished` reports and before the stream closes. Both matter: a consumer
       * released by `close()` must not race the code that read what the handler
       * recorded, and a client that never sees `[DONE]` waits for ever.
       *
       * Written on the failure path too. An error frame says the turn died; the
       * tail is what tells the reader to stop reading, which is true either way.
       */
      const closeSurface = (): void => {
        const tail = input.renderer?.finish?.();
        if (tail !== undefined && tail !== '') controller.enqueue(encoder.encode(tail));
      };

      const consume = (chunk: Uint8Array): void => {
        if (!sawFirst) {
          sawFirst = true;
          handlers.firstChunk?.();
        }
        // On the direct route the provider's bytes go on unchanged. They are
        // decoded regardless, because usage is what quota accounting is made of
        // and the provider only says it once.
        if (input.renderer === null) controller.enqueue(chunk);
        emit(input.decoder.push(text.decode(chunk, { stream: true })));
      };

      try {
        consume(input.first);
        for (;;) {
          const step = await withTimeout(
            input.reader.read(),
            input.stallMs,
            `${input.provider} stopped sending part-way through the answer.`,
          );
          if (step.done) break;
          consume(step.value);
        }
        // A trailing frame the provider never terminated, and the finish a codec
        // held back until it had the usage to go with it.
        emit(input.decoder.flush());
        closeSurface();
        // Reported *before* the stream closes. A consumer awaiting the body is
        // released the moment `close()` lands, so a handler called after it would
        // race the code that reads what the handler recorded — and the loser of
        // that race is a telemetry row nobody sees.
        handlers.finished(usage);
        controller.close();
      } catch (error) {
        handlers.failed(error);
        await input.reader.cancel().catch(() => undefined);
        if (input.renderer === null) {
          controller.error(error);
          return;
        }
        emit([{ type: 'error', error: apiErrorOf(error) }]);
        closeSurface();
        controller.close();
      }
    },
  });
}

function apiErrorOf(error: unknown): ApiError {
  return (isAppError(error) ? error : AppError.internal(error)).toApiError(null);
}

/**
 * Race a step against a clock, and clear the clock either way.
 *
 * The loser is not leaked: `Promise.race` subscribes to every promise it is given,
 * so a guard that rejects after the work has won is consumed rather than surfacing
 * as an unhandled rejection.
 */
function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new AppError('timeout', message));
    }, ms);
  });
  return Promise.race([work, guard]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
