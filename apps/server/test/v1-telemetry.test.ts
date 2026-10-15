import { afterEach, describe, expect, it } from 'vitest';
import type { ApiKeyInput } from '@contracts';

import { buildApp } from '@server/app.ts';
import type { ResponseFetcher } from '@server/providers/outbound.ts';
import { SecretBox } from '@server/security/secret-box.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * What a `/v1` turn writes down (C6, FR-12.2–12.4).
 *
 * The readers are covered in `overview-routes.test.ts` against seeded rows; this
 * file is about the writer. A telemetry row is only useful if it is written on
 * every ending, so the cases here are the endings: a plain answer, a stream, a
 * refusal that never reached a provider, and a stream that died after its headers.
 *
 * The cost assertion is the one that ties the two halves together — it is computed
 * from the manifest's own price list, so a row's `costUsd` is a claim about what
 * the provider charges rather than a number rutekit made up.
 */

const KEY_HEX = 'a'.repeat(64);
const OPENAI_KEY = 'sk-openai-test';

type App = ReturnType<typeof buildApp>;

const servers: TestServer[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
});

interface Call {
  readonly url: string;
  readonly body: string;
}

function responder(answer: (call: Call) => Response): {
  fetcher: ResponseFetcher;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetcher: ResponseFetcher = (url, init) => {
    const call: Call = { url, body: typeof init.body === 'string' ? init.body : '' };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { fetcher, calls };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'gpt-4o',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
};

interface Harness {
  readonly server: TestServer;
  readonly app: App;
  readonly box: SecretBox;
}

function harness(options: { fetcher: ResponseFetcher }): Harness {
  const box = new SecretBox(KEY_HEX);
  const server = makeServer({ secrets: box, fetch: options.fetcher });
  server.lifecycle.markReady();
  servers.push(server);
  return { server, app: buildApp(server), box };
}

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

async function post(
  app: App,
  path: string,
  body: unknown,
  secret: string,
): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
}

const TURN = { messages: [{ role: 'user', content: 'Hi' }] } as const;

/** The most recent row, or a failure — every test below expects exactly one. */
function lastRow(server: TestServer) {
  const rows = server.requests.listBetween(
    new Date(0).toISOString(),
    new Date(Date.now() + 60_000).toISOString(),
    {},
    10,
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe('a served turn', () => {
  it('writes one row naming the provider, the model and the account', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    await post(app, '/v1/chat/completions', { model: 'gpt-4o', ...TURN }, secret);

    const row = lastRow(server);
    expect(row.status).toBe(200);
    expect(row.providerId).toBe('openai');
    expect(row.model).toBe('gpt-4o');
    expect(row.accountId).not.toBeNull();
    expect(row.path).toBe('/v1/chat/completions');
    expect(row.errorKind).toBeNull();
    expect(row.requestId).not.toBeNull();
  });

  it('records the usage the provider reported', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    await post(app, '/v1/chat/completions', { model: 'gpt-4o', ...TURN }, secret);

    const row = lastRow(server);
    expect(row.inputTokens).toBe(1_000_000);
    expect(row.outputTokens).toBe(1_000_000);
  });

  it('prices the turn from the manifest’s own rate', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    await post(app, '/v1/chat/completions', { model: 'gpt-4o', ...TURN }, secret);

    // `gpt-4o` is $2.50/M in and $10/M out in the shipped manifest, and the
    // response claims a million of each — so the row's cost is a claim about the
    // provider's price list rather than a number rutekit invented.
    expect(lastRow(server).costUsd).toBe(12.5);
  });

  it('leaves the time to first token null on a non-streaming answer', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    await post(app, '/v1/chat/completions', { model: 'gpt-4o', ...TURN }, secret);

    // Nothing streamed, so no first token was ever observed. Zero would claim one
    // arrived instantly.
    expect(lastRow(server).ttftMs).toBeNull();
    expect(lastRow(server).streamed).toBe(false);
  });

  it('records the model id the provider was actually asked for', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    await post(app, '/v1/chat/completions', { model: 'gpt-4o', ...TURN }, secret);

    // The row names the model rutekit resolved, which is what the provider's own
    // price list is keyed on — an alias would have no price to look up.
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ model: 'gpt-4o' });
    expect(lastRow(server).model).toBe('gpt-4o');
  });
});

describe('a streamed turn', () => {
  const UPSTREAM = [
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n',
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
    'data: [DONE]\n\n',
  ].join('');

  it('records the usage that arrives in the last frame, not the first', async () => {
    const { fetcher } = responder(
      () => new Response(UPSTREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    const response = await post(
      app,
      '/v1/chat/completions',
      { model: 'gpt-4o', stream: true, ...TURN },
      secret,
    );
    // Draining the body is what finishes the pump, and the row is written from
    // the pump's terminal callback — so this is the moment the row lands.
    await response.text();

    const row = lastRow(server);
    expect(row.streamed).toBe(true);
    expect(row.status).toBe(200);
    expect(row.inputTokens).toBe(3);
    expect(row.outputTokens).toBe(1);
  });

  it('records a time to first token for a stream', async () => {
    const { fetcher } = responder(
      () => new Response(UPSTREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    const response = await post(
      app,
      '/v1/chat/completions',
      { model: 'gpt-4o', stream: true, ...TURN },
      secret,
    );
    await response.text();

    // A stream did observe its first token, so the column is a number.
    expect(lastRow(server).ttftMs).not.toBeNull();
  });

  it('writes exactly one row for a stream, not two', async () => {
    const { fetcher } = responder(
      () => new Response(UPSTREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    const response = await post(
      app,
      '/v1/chat/completions',
      { model: 'gpt-4o', stream: true, ...TURN },
      secret,
    );
    await response.text();

    // The pump writes the row, and the caller must not write a second on top of
    // it — `lastRow` asserts the count is one.
    lastRow(server);
  });
});

describe('a refused turn', () => {
  it('records a request for a model nothing serves', async () => {
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
    // The operator asked for something and got nothing; the console has to show
    // that, so a refusal is a row like any other.
    const row = lastRow(server);
    expect(row.status).toBe(404);
    expect(row.errorKind).toBe('not_found');
    expect(row.providerId).toBeNull();
    expect(row.model).toBeNull();
  });

  it('records a request the key may not use', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server, { modelsAllowed: ['gpt-4o-mini'] });

    const response = await post(app, '/v1/chat/completions', { model: 'gpt-4o', ...TURN }, secret);

    expect(response.status).toBe(403);
    const row = lastRow(server);
    expect(row.status).toBe(403);
    expect(row.errorKind).toBe('permission');
  });

  it('records an upstream failure against the provider it was sent to', async () => {
    const { fetcher } = responder(() =>
      jsonResponse({ error: { message: 'exploded' } }, 502),
    );
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    const response = await post(app, '/v1/chat/completions', { model: 'gpt-4o', ...TURN }, secret);

    expect(response.status).toBe(502);
    const row = lastRow(server);
    // The turn did reach a provider, so the row names it — which is what makes
    // "which upstream is failing" answerable from the request table.
    expect(row.providerId).toBe('openai');
    expect(row.model).toBe('gpt-4o');
    expect(row.errorKind).toBe('upstream_error');
  });

  it('records a malformed body', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const { server, app } = harness({ fetcher });
    const secret = mintKey(server);

    const response = await post(app, '/v1/chat/completions', { model: 'gpt-4o' }, secret);

    expect(response.status).toBe(400);
    expect(lastRow(server).errorKind).toBe('invalid_request');
  });
});

describe('payload capture', () => {
  it('stores nothing while the switch is off', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    await post(app, '/v1/chat/completions', { model: 'gpt-4o', ...TURN }, secret);

    // Off by default, and off means no rows at all rather than empty ones.
    expect(server.persistence.sqlite.query('select count(*) as n from request_captures').get()).toEqual({
      n: 0,
    });
  });

  it('stores a redacted client request once the switch is on', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    server.settings.write({ payloadCaptureEnabled: true });
    const secret = mintKey(server);

    await post(
      app,
      '/v1/chat/completions',
      { model: 'gpt-4o', api_key: 'sk-proj-abcdefghijklmnopqrstuvwxyz', ...TURN },
      secret,
    );

    const captures = server.requests.capturesFor(
      lastRow(server).id,
      new Date(Date.now() + 60_000).toISOString(),
    );
    const client = captures.find((capture) => capture.stage === 'client_request');

    expect(client).toBeDefined();
    // Redacted on the way in, so what is on disk is never the credential (SEC-6).
    expect(client?.body).toContain('[redacted]');
    expect(client?.body).not.toContain('sk-proj-');
    expect(client?.redacted).toBe(true);
  });

  it('captures the canonical pivot and the upstream body too', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    server.settings.write({ payloadCaptureEnabled: true });
    const secret = mintKey(server);

    await post(app, '/v1/chat/completions', { model: 'gpt-4o', ...TURN }, secret);

    const captures = server.requests.capturesFor(
      lastRow(server).id,
      new Date(Date.now() + 60_000).toISOString(),
    );
    const stages = captures.map((capture) => capture.stage).sort();

    // The pivot is what the routing decision acted on, and the upstream body is
    // what the provider was actually sent — the two panels an operator reads when
    // asking "what did rutekit do with my request".
    expect(stages).toEqual(['canonical', 'client_request', 'upstream_request']);
  });

  it('stamps the capture with a TTL from the settings record', async () => {
    const { fetcher } = responder(() => jsonResponse(COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    server.settings.write({ payloadCaptureEnabled: true, payloadCaptureTtlMinutes: 15 });
    const secret = mintKey(server);

    await post(app, '/v1/chat/completions', { model: 'gpt-4o', ...TURN }, secret);

    const captures = server.requests.capturesFor(
      lastRow(server).id,
      new Date(Date.now() + 60_000).toISOString(),
    );
    const capture = captures[0];
    if (capture === undefined) throw new Error('no capture written');

    const ttlMs = Date.parse(capture.expiresAt) - Date.parse(capture.capturedAt);
    expect(ttlMs).toBe(15 * 60_000);
  });
});
