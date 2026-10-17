import { describe, expect, it } from 'vitest';
import { createProviderRegistry } from '@registry';
import { providerManifests } from '@registry/providers/index.ts';

import { AppError } from '@server/errors.ts';
import { silentLogger } from '@server/observability/logger.ts';
import { callProvider } from '@server/providers/provider-call.ts';
import { parseConfig } from '@server/runtime/config.ts';

/**
 * What a provider that accepts a request and then says nothing costs (C4.6).
 *
 * **`arrayBuffer()` waits for the connection to end, which is not a deadline.**
 * qoder commits a 200 for a model its plan does not cover and sends no bytes at
 * all; the socket stayed open for two minutes and the turn arrived as
 * `ECONNRESET` — reported as "stopped answering", which reads like a network
 * fault and names neither the model nor the plan.
 *
 * The streaming path has always had a first-byte clock. These tests pin the same
 * clock on the non-streaming path, which is the one a client that did not ask for
 * a stream gets.
 */

const manifest = createProviderRegistry(providerManifests).get('openai');
if (manifest === undefined) throw new Error('the catalogue has no openai manifest');

const config = parseConfig(
  {
    RUTEKIT_DATABASE_URL: ':memory:',
    // Small enough to keep the test quick, large enough not to race the event loop.
    RUTEKIT_STREAM_FIRST_CHUNK_MS: '60',
    RUTEKIT_UPSTREAM_TIMEOUT_MS: '60000',
  },
  process.cwd(),
);

/** A body that opens and never emits, which is what an uncovered model looks like. */
function silentBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(): void {
      // Deliberately empty: the provider holds the connection without answering.
    },
  });
}

function options(fetch: (url: string, init: RequestInit) => Promise<Response>) {
  return {
    fetch,
    config,
    logger: silentLogger(),
    requestId: null,
    render: (raw: Uint8Array) => ({ bytes: raw.length }),
    streamDecoder: () => ({
      push: () => [],
      flush: () => [],
    }),
    renderer: () => null,
    onStreamEnd: () => undefined,
  };
}

const call = {
  manifest,
  url: 'https://api.openai.test/v1/chat/completions',
  headers: {},
  body: '{}',
  stream: false,
};

describe('a non-streaming answer that never starts', () => {
  it('is given up on at the first-byte clock, not at the request timeout', async () => {
    // The whole point: the request timeout is a minute in this config, and the
    // turn must not take it. A provider that has committed a 200 and sent nothing
    // is answering badly, and the client should hear that while it is still
    // waiting rather than after the socket dies.
    const started = Date.now();
    const failure = await callProvider(
      call,
      options(() => Promise.resolve(new Response(silentBody(), { status: 200 }))),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).kind).toBe('timeout');
    expect((failure as AppError).message).toContain('did not start answering');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('names an empty body as empty, not as a network fault', async () => {
    const failure = await callProvider(
      call,
      options(() => Promise.resolve(new Response('', { status: 200 }))),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).message).toContain('empty body');
  });

  it('still reads a body that does arrive', async () => {
    const response = await callProvider(
      call,
      options(() => Promise.resolve(new Response('{"ok":true}', { status: 200 }))),
    );

    expect(await response.json()).toEqual({ bytes: 11 });
  });

  it('assembles a body that arrives in pieces', async () => {
    // The primer consumes one chunk and the rest is drained after it; a body split
    // across chunks is the normal case for anything but a tiny answer.
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('{"ok":'));
        controller.enqueue(new TextEncoder().encode('true}'));
        controller.close();
      },
    });

    const response = await callProvider(
      call,
      options(() => Promise.resolve(new Response(body, { status: 200 }))),
    );

    expect(await response.json()).toEqual({ bytes: 11 });
  });
});
