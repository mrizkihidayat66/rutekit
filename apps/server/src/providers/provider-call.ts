import type { Logger } from 'pino';
import type { Usage } from '@contracts';
import type { ProviderManifest } from '@registry';
import type { StreamDecoder, StreamRenderer } from '@translator';

import { AppError } from '@server/errors.ts';
import type { ServerConfig } from '@server/runtime/config.ts';

import { retryAfterOf, upstreamFailure } from './dispatch-errors.ts';
import type { ResponseFetcher } from './outbound.ts';
import { primeFirstChunk, pumpStream } from './stream-pump.ts';

/**
 * The one call rutekit makes to a provider, and the two shapes it comes back in.
 *
 * Both shapes share a clock: `upstreamTimeoutMs` aborts the request, and because
 * the abort signal also covers the body it stays armed while the answer is being
 * read. That is the only reason a provider which accepts a request and then says
 * nothing cannot hold the connection open for ever, and it is why the timer is
 * cleared on every exit rather than after the `fetch` resolves.
 *
 * The non-streaming shape has one wrinkle worth naming: `render` may answer null,
 * and null means the provider's own bytes are the answer. That is the `direct`
 * route — a pair whose two dialects are the same one, where re-rendering would
 * cost exactly the fields the pivot does not model.
 */

export interface ProviderCall {
  readonly manifest: ProviderManifest;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** True when the client asked for a stream, which the encoded body mirrors. */
  readonly stream: boolean;
}

export interface CallOptions {
  readonly fetch: ResponseFetcher;
  readonly config: ServerConfig;
  readonly logger: Logger;
  readonly requestId: string | null;
  /**
   * The answer, rendered for the client's surface — or `null` to hand the
   * provider's own bytes on unchanged. Usage is recorded here either way.
   *
   * The return type is `unknown` rather than `unknown | null` because the latter
   * is just `unknown`; a rendered body is always an object, so the `null` this
   * checks for can only have been put there to mean the direct route.
   */
  readonly render: (raw: string) => unknown;
  readonly streamDecoder: () => StreamDecoder;
  /** Null on the direct route, where there is nothing to render frames with. */
  readonly renderer: () => StreamRenderer | null;
  /**
   * Once, when a **stream** ends — cleanly, or with the error that ended it.
   *
   * A stream is the one shape whose outcome is not known when this function
   * returns: the 200 goes out with the headers, and the usage arrives in the last
   * frame long afterwards. So the caller gets a callback rather than a return
   * value, and it fires on both endings so a stream that dies still accounts for
   * itself.
   */
  readonly onStreamEnd: (outcome: StreamEnd) => void;
  /** Once, the moment the provider's first bytes arrive. The stream's TTFT. */
  readonly onFirstChunk?: () => void;
}

/**
 * How a stream ended.
 *
 * A discriminated union rather than a pair of nullable fields, because the two
 * cases carry different things and "both set" or "neither set" are states that
 * cannot happen — the pump calls exactly one of its two handlers.
 */
export type StreamEnd =
  | { readonly ok: true; readonly usage: Usage | null }
  | { readonly ok: false; readonly error: unknown };

const JSON_HEADERS: Readonly<Record<string, string>> = { 'content-type': 'application/json' };
const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
};

export async function callProvider(call: ProviderCall, options: CallOptions): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
  }, options.config.upstreamTimeoutMs);
  const stopClock = (): void => {
    clearTimeout(timer);
  };

  let upstream: Response;
  try {
    upstream = await options.fetch(call.url, {
      method: 'POST',
      headers: call.headers,
      body: call.body,
      signal: abort.signal,
    });
  } catch (cause) {
    stopClock();
    throw AppError.upstreamError(`${call.manifest.name} could not be reached.`, {
      provider: call.manifest.id,
      cause,
    });
  }

  if (!upstream.ok) {
    const body = await readBody(upstream, call.manifest, abort, stopClock);
    throw upstreamFailure(call.manifest, upstream.status, body, retryAfterOf(upstream.headers));
  }

  if (!call.stream) {
    const body = await readBody(upstream, call.manifest, abort, stopClock);
    const rendered = options.render(body);
    return rendered === null
      ? new Response(body, { status: 200, headers: JSON_HEADERS })
      : Response.json(rendered, { headers: JSON_HEADERS });
  }

  // `@types/bun` types a `Response` body's reader with `any` chunks, while the
  // stream machinery below is written against `Uint8Array`. A fetch body is
  // bytes, so the narrowing is a statement of fact rather than an assumption.
  const reader = upstream.body?.getReader() as
    | ReadableStreamDefaultReader<Uint8Array>
    | undefined;
  if (reader === undefined) {
    stopClock();
    throw AppError.upstreamError(`${call.manifest.name} answered without a body.`, {
      provider: call.manifest.id,
    });
  }

  let first: Uint8Array;
  try {
    // The status is committed on the next line, so this is the last moment a
    // provider that never started talking can still be reported as a failure.
    first = await primeFirstChunk(reader, options.config.streamFirstChunkMs, call.manifest.name);
  } catch (error) {
    stopClock();
    throw error;
  }

  const stream = pumpStream(
    {
      reader,
      first,
      decoder: options.streamDecoder(),
      renderer: options.renderer(),
      stallMs: options.config.streamStallMs,
      provider: call.manifest.name,
    },
    {
      ...(options.onFirstChunk === undefined ? {} : { firstChunk: options.onFirstChunk }),
      finished: (usage) => {
        stopClock();
        options.onStreamEnd({ ok: true, usage });
      },
      failed: (error) => {
        stopClock();
        options.logger.warn({ err: error, requestId: options.requestId }, 'stream ended early');
        options.onStreamEnd({ ok: false, error });
      },
    },
  );

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

/** A whole body, with the upstream clock still covering it. */
async function readBody(
  upstream: Response,
  manifest: ProviderManifest,
  abort: AbortController,
  stopClock: () => void,
): Promise<string> {
  try {
    return await upstream.text();
  } catch (cause) {
    if (abort.signal.aborted) {
      throw AppError.timeout(`${manifest.name} ran out of time answering.`, {
        provider: manifest.id,
      });
    }
    throw AppError.upstreamError(`${manifest.name} stopped answering.`, {
      provider: manifest.id,
      cause,
    });
  } finally {
    stopClock();
  }
}
