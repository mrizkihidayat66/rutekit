import { afterEach, describe, expect, it } from 'vitest';
import { modelsResponseSchema, openAiErrorSchema } from '@contracts';
import type { ApiKeyInput } from '@contracts';

import { buildApp } from '@server/app.ts';
import type { ResponseFetcher } from '@server/providers/outbound.ts';
import { defaultTokenSaverConfig } from '@server/runtime/token-saver.ts';
import { SecretBox } from '@server/security/secret-box.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The data plane, end to end (C4.6, C4.7).
 *
 * One `/v1` turn, driven through the real composition: the API-key guard, the
 * dispatcher, the translator's pivot, the codecs and the Token Saver, with only
 * the socket replaced. `makeServer`'s `fetch` seam stands in for a provider, so
 * what these assert is the shape rutekit sends and the shape it returns — the two
 * things a client on the other side can actually see.
 *
 * The two routes are the point of the file. `chooseRoute` calls
 * `chat-completions`+`openai` and `messages`+`anthropic` exact, so those two
 * pairs hand the provider's own bytes back untouched and the rest pivot; both
 * directions are asserted here rather than assumed, because the direct route
 * exists precisely for the fields the pivot would drop.
 */

const KEY_HEX = 'a'.repeat(64);
const OPENAI_KEY = 'sk-openai-test';
const ANTHROPIC_KEY = 'sk-ant-test';

type App = ReturnType<typeof buildApp>;

const servers: TestServer[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
});

/** A call rutekit made to a provider, as the fake transport saw it. */
interface Call {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

/**
 * A transport that records what it was asked and answers with what the test
 * says. Recording is the whole reason this is not a one-line `fetch` stub: the
 * request rutekit built is half of what these tests are about.
 */
function responder(answer: (call: Call) => Response): { fetcher: ResponseFetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher: ResponseFetcher = (url, init) => {
    const call: Call = {
      url,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : '',
    };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { fetcher, calls };
}

function jsonResponse(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

interface Harness {
  readonly server: TestServer;
  readonly app: App;
  readonly box: SecretBox;
}

function harness(options: { fetcher: ResponseFetcher; env?: Record<string, string> }): Harness {
  const box = new SecretBox(KEY_HEX);
  const server = makeServer({
    secrets: box,
    fetch: options.fetcher,
    env: options.env ?? {},
  });
  server.lifecycle.markReady();
  servers.push(server);
  return { server, app: buildApp(server), box };
}

/** Store a usable credential, so the dispatcher has an account to call with. */
function addAccount(server: TestServer, box: SecretBox, providerId: string, credential: string): void {
  const at = new Date().toISOString();
  server.accounts.create({
    id: crypto.randomUUID(),
    providerId,
    label: `${providerId} test`,
    credentialEnvelope: box.encrypt(credential),
    authMode: 'api-key',
    createdAt: at,
    updatedAt: at,
  });
}

/** Mint a key with the contract's own defaults, overriding only what a test needs. */
function mintKey(server: TestServer, overrides: Partial<ApiKeyInput> = {}): string {
  const input: ApiKeyInput = {
    name: overrides.name ?? 'test',
    modelsAllowed: overrides.modelsAllowed ?? [],
    modelsDenied: overrides.modelsDenied ?? [],
    budgetRequests: overrides.budgetRequests ?? null,
    budgetTokens: overrides.budgetTokens ?? null,
    tpsLimit: overrides.tpsLimit ?? null,
    rateLimitPerMinute: overrides.rateLimitPerMinute ?? null,
    expiresAt: overrides.expiresAt ?? null,
    clientRouterDenylist: overrides.clientRouterDenylist ?? [],
  };
  return server.apiKeys.create(input).secret;
}

async function post(app: App, path: string, body: unknown, secret: string): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
}

/** A refusal as the OpenAI surfaces render it. */
async function v1ErrorOf(response: Response): Promise<{ kind: string; message: string }> {
  const { error } = openAiErrorSchema.parse(await response.json());
  return { kind: error.type, message: error.message };
}

/**
 * A refusal as `/v1/messages` renders it.
 *
 * The dialect follows the surface, not the namespace: a Claude client reads
 * `{ type: 'error', error: { type, message } }`, and the reason lands in the
 * inner `type`. Reading it through the OpenAI schema would report a parse failure
 * where the client sees a perfectly good refusal.
 */
async function messagesErrorOf(response: Response): Promise<{ kind: string; message: string }> {
  const body = (await response.json()) as {
    type: string;
    error: { type: string; message: string };
  };
  expect(body.type).toBe('error');
  return { kind: body.error.type, message: body.error.message };
}

/** An OpenAI completion carrying a vendor field the pivot has no column for. */
const OPENAI_COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'gpt-4o',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  // The direct route exists to keep exactly this: a field the pivot would drop
  // on the way back out if the answer were re-rendered.
  system_fingerprint: 'fp_vendor_only',
};

/** An Anthropic body, for the pivot direction. */
const ANTHROPIC_MESSAGE = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-3-opus-20240229',
  content: [{ type: 'text', text: 'Hello.' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 2 },
};

const TURN = { messages: [{ role: 'user', content: 'Hi' }] } as const;

describe('/v1/models', () => {
  it('lists the catalogue in the OpenAI envelope', async () => {
    const { fetcher } = responder(() => jsonResponse({}));
    const { server, app } = harness({ fetcher });
    const secret = mintKey(server);

    const response = await app.request('/v1/models', {
      headers: { authorization: `Bearer ${secret}` },
    });

    expect(response.status).toBe(200);
    const listing = modelsResponseSchema.parse(await response.json());
    expect(listing.object).toBe('list');
    expect(listing.data.map((model) => model.id)).toContain('gpt-4o');
  });
});

describe('the direct route', () => {
  it('hands back the provider’s own bytes for an exact pair', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(OPENAI_COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    const response = await post(
      app,
      '/v1/chat/completions',
      { model: 'gpt-4o', ...TURN },
      secret,
    );

    expect(response.status).toBe(200);
    // Byte for byte, `system_fingerprint` included: a `chat-completions` turn to
    // an OpenAI provider is the pair `chooseRoute` calls exact, so nothing is
    // re-rendered and nothing is lost.
    expect(await response.json()).toEqual(OPENAI_COMPLETION);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${OPENAI_KEY}`);
  });
});

describe('the pivot route', () => {
  it('re-renders a provider answer for the client’s surface', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(ANTHROPIC_MESSAGE));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'anthropic', ANTHROPIC_KEY);
    const secret = mintKey(server);

    const response = await post(
      app,
      '/v1/chat/completions',
      { model: 'claude-3-opus-20240229', ...TURN },
      secret,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { object: string; choices: unknown[] };
    // The OpenAI shape, not the Anthropic body: an OpenAI client asking an
    // Anthropic provider is not an exact pair, so the answer went through the
    // pivot on the way back.
    expect(body.object).toBe('chat.completion');
    expect(body.choices).toHaveLength(1);
    // The provider's own dialect is spoken on the way out: `x-api-key`, no scheme.
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]?.headers.get('x-api-key')).toBe(ANTHROPIC_KEY);
  });

  it('opens a Claude stream with message_start before any other frame', async () => {
    const upstream = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const { fetcher } = responder(
      () =>
        new Response(upstream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    const response = await post(
      app,
      '/v1/messages',
      { model: 'gpt-4o', max_tokens: 64, stream: true, ...TURN },
      secret,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const text = await response.text();
    const frames = text.split('\n\n').filter((frame) => frame.trim() !== '');
    // A Claude client allocates the message from `message_start`, so it has to be
    // the first frame on the wire — present somewhere in the stream is not enough.
    expect(frames[0]).toContain('event: message_start');
    expect(text).toContain('event: message_stop');
  });
});

describe('the stream prime', () => {
  it('reports a provider that never starts as a timeout, before committing 200', async () => {
    // A 200 whose body never yields: the failure the first-chunk clock exists for.
    const silent = new ReadableStream<Uint8Array>({ start() {} });
    const { fetcher } = responder(() => new Response(silent, { status: 200 }));
    const { server, app, box } = harness({
      fetcher,
      env: { RUTEKIT_STREAM_FIRST_CHUNK_MS: '50' },
    });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    const response = await post(
      app,
      '/v1/messages',
      { model: 'gpt-4o', max_tokens: 64, stream: true, ...TURN },
      secret,
    );

    // A 200 would already have been committed if the first chunk were not read
    // under its own clock, and no later failure could change it.
    expect(response.status).toBe(504);
    expect((await messagesErrorOf(response)).kind).toBe('timeout');
  });
});

describe('the refusals', () => {
  it('answers not_found for a model no provider serves', async () => {
    const { fetcher } = responder(() => jsonResponse({}));
    const { server, app } = harness({ fetcher });
    const secret = mintKey(server);

    const response = await post(
      app,
      '/v1/chat/completions',
      { model: 'no-such-model', ...TURN },
      secret,
    );

    expect(response.status).toBe(404);
    expect((await v1ErrorOf(response)).kind).toBe('not_found');
  });

  it('refuses a model the key may not use', async () => {
    const { fetcher } = responder(() => jsonResponse(ANTHROPIC_MESSAGE));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'anthropic', ANTHROPIC_KEY);
    const secret = mintKey(server, { modelsAllowed: ['gpt-4o'] });

    const response = await post(
      app,
      '/v1/chat/completions',
      { model: 'claude-3-opus-20240229', ...TURN },
      secret,
    );

    expect(response.status).toBe(403);
    expect((await v1ErrorOf(response)).kind).toBe('permission');
  });

  it('reads a spent balance as quota_exhausted, with the retry hint on the header', async () => {
    const { fetcher } = responder(() =>
      jsonResponse(
        { error: { message: 'You exceeded your current quota', type: 'insufficient_quota' } },
        429,
        { 'retry-after': '7' },
      ),
    );
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    const response = await post(app, '/v1/chat/completions', { model: 'gpt-4o', ...TURN }, secret);

    // The manifest's rule order is what makes this a quota and not a rate limit:
    // the same status means two different things to the account pool.
    expect(response.status).toBe(429);
    expect((await v1ErrorOf(response)).kind).toBe('quota_exhausted');
    expect(response.headers.get('retry-after')).toBe('7');
  });

  it('reads a bare 429 as a rate limit', async () => {
    const { fetcher } = responder(() =>
      jsonResponse({ error: { message: 'Too many requests' } }, 429),
    );
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    const response = await post(app, '/v1/chat/completions', { model: 'gpt-4o', ...TURN }, secret);

    expect(response.status).toBe(429);
    expect((await v1ErrorOf(response)).kind).toBe('rate_limit');
  });
});

describe('the Token Saver', () => {
  /** A generated schema carries `title`; a model never reads it. */
  const TOOL = {
    type: 'function',
    function: {
      name: 'lookup',
      description: 'Look something up.',
      parameters: { type: 'object', title: 'LookupArgs', properties: { q: { type: 'string' } } },
    },
  } as const;

  function sentSchema(calls: Call[]): Record<string, unknown> {
    const sent = JSON.parse(calls[0]?.body ?? '{}') as {
      tools?: { input_schema?: Record<string, unknown> }[];
    };
    return sent.tools?.[0]?.input_schema ?? {};
  }

  it('compresses the request before it reaches the provider', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(ANTHROPIC_MESSAGE));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'anthropic', ANTHROPIC_KEY);
    const secret = mintKey(server);

    await post(
      app,
      '/v1/chat/completions',
      { model: 'claude-3-opus-20240229', tools: [TOOL], ...TURN },
      secret,
    );

    // TSC strips schema annotations, and the request that left rutekit proves it
    // ran: the provider sees the compacted schema, not the one the client sent.
    expect(sentSchema(calls)).not.toHaveProperty('title');
    expect(sentSchema(calls)).toHaveProperty('properties');
  });

  it('leaves the request alone when the operator turns it off', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(ANTHROPIC_MESSAGE));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'anthropic', ANTHROPIC_KEY);
    const secret = mintKey(server);
    server.tokenSaver.write({ ...defaultTokenSaverConfig(), enabled: false });

    await post(
      app,
      '/v1/chat/completions',
      { model: 'claude-3-opus-20240229', tools: [TOOL], ...TURN },
      secret,
    );

    // The master switch is checked first, so a disabled pipeline is inert: the
    // annotation the stage would have stripped is still on the wire.
    expect(sentSchema(calls)).toHaveProperty('title');
  });
});
