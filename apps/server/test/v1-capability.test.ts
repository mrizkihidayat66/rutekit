import { afterEach, describe, expect, it } from 'vitest';
import { openAiErrorSchema } from '@contracts';
import type { ApiKeyInput } from '@contracts';

import { buildApp } from '@server/app.ts';
import type { ResponseFetcher } from '@server/providers/outbound.ts';
import { SecretBox } from '@server/security/secret-box.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * Capability-aware routing, end to end (C5c, FR-1.6).
 *
 * What this file adds over `capability.test.ts` is the wire: the request rutekit
 * actually built, and what it said about it. The unit tests prove the rewrite is
 * right; these prove the rewrite reaches the provider and that the client is told
 * what it cost.
 *
 * The pair that matters is `x-rutekit-degraded` and the body. FR-1.6 forbids a
 * silent substitution, so the assertion is always two-sided: the provider received
 * the degraded body (so nothing unsupported was sent), *and* the client was told
 * which controls went missing (so nothing was silent).
 */

const KEY_HEX = 'a'.repeat(64);
const OPENAI_KEY = 'sk-openai-test';
const GROQ_KEY = 'gsk-groq-test';
const DEEPINFRA_KEY = 'di-test';

/**
 * A model that declares nothing: no vision, no tools, no reasoning.
 *
 * Every "this control was dropped" test needs one, because a manifest is explicit
 * about what a model *can* do — `llama-3.1-8b-instant` declares tools, so a tool
 * request to it is not degraded at all.
 */
const BARE_MODEL = 'mistralai/Mixtral-8x7B-Instruct-v0.1';

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

const OPENAI_COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'gpt-4o',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
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

function addAccount(
  server: TestServer,
  box: SecretBox,
  providerId: string,
  credential: string,
): void {
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

async function post(app: App, body: unknown, secret: string): Promise<Response> {
  return app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
}

async function errorOf(response: Response): Promise<{ kind: string; message: string }> {
  const { error } = openAiErrorSchema.parse(await response.json());
  return { kind: error.type, message: error.message };
}

/** The body rutekit actually sent upstream. */
function sentBody(calls: Call[], index = 0): Record<string, unknown> {
  return JSON.parse(calls[index]?.body ?? '{}') as Record<string, unknown>;
}

const IMAGE_TURN = {
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
      ],
    },
  ],
} as const;

const TOOL_TURN = {
  messages: [{ role: 'user', content: 'Weather?' }],
  tools: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Look up the weather.',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    },
  ],
} as const;

function addCombo(
  server: TestServer,
  input: { name: string; entries: { model: string; providerId?: string | null }[] },
): void {
  const at = new Date().toISOString();
  server.combos.create(
    {
      id: crypto.randomUUID(),
      name: input.name,
      displayName: input.name,
      description: null,
      strategy: 'sequential',
      fallbackOnError: true,
      enabled: true,
      createdAt: at,
      updatedAt: at,
    },
    input.entries.map((entry) => ({
      model: entry.model,
      providerId: entry.providerId ?? null,
      weight: 1,
      enabled: true,
    })),
  );
}

describe('a model that cannot express the request', () => {
  it('replaces the image and says so on the header', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(OPENAI_COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'groq', GROQ_KEY);
    const secret = mintKey(server);

    const response = await post(
      app,
      { model: 'llama-3.1-8b-instant', ...IMAGE_TURN },
      secret,
    );

    expect(response.status).toBe(200);
    // The client is told which control went missing. This is the half that makes
    // the substitution non-silent, and FR-1.6 is the reason it exists.
    expect(response.headers.get('x-rutekit-degraded')).toBe('vision');

    const sent = JSON.stringify(sentBody(calls).messages);
    expect(sent).toContain('[image omitted: llama-3.1-8b-instant cannot accept images]');
    // Nothing that looks like an image reached a model that cannot take one.
    expect(sent).not.toContain('image_url');
  });

  it('drops the tool definitions and clears the choice', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(OPENAI_COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'deepinfra', DEEPINFRA_KEY);
    const secret = mintKey(server);

    const response = await post(app, { model: BARE_MODEL, ...TOOL_TURN }, secret);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-rutekit-degraded')).toBe('tools');
    // A model with no tool support is sent a request that never mentions tools.
    expect(sentBody(calls)).not.toHaveProperty('tools');
  });

  it('sends nothing extra when the model can express everything', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(OPENAI_COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    const response = await post(app, { model: 'gpt-4o', ...IMAGE_TURN }, secret);

    expect(response.status).toBe(200);
    // No header when nothing was dropped: an absent header means "untouched", and
    // an empty one would make every client parse a value that says nothing.
    expect(response.headers.get('x-rutekit-degraded')).toBeNull();
    expect(JSON.stringify(sentBody(calls).messages)).toContain('image_url');
  });

  it('lists several dropped controls in the fixed order', async () => {
    const { fetcher } = responder(() => jsonResponse(OPENAI_COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'deepinfra', DEEPINFRA_KEY);
    const secret = mintKey(server);

    const response = await post(
      app,
      {
        model: BARE_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Weather in this photo?' },
              { type: 'image_url', image_url: { url: 'https://example.com/city.png' } },
            ],
          },
        ],
        tools: TOOL_TURN.tools,
      },
      secret,
    );

    expect(response.headers.get('x-rutekit-degraded')).toBe('vision,tools');
  });
});

describe('a combo under capability-aware routing', () => {
  it('sends the capable entry first, without degrading anything', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(OPENAI_COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'groq', GROQ_KEY);
    addAccount(server, box, 'openai', OPENAI_KEY);
    // Written the wrong way round on purpose: the entry that cannot see images
    // is listed first, and the ranking is what has to fix that.
    addCombo(server, {
      name: 'chain',
      entries: [{ model: 'llama-3.1-8b-instant' }, { model: 'gpt-4o' }],
    });
    const secret = mintKey(server);

    const response = await post(app, { model: 'chain', ...IMAGE_TURN }, secret);

    expect(response.status).toBe(200);
    // The capable entry answered, so nothing was dropped — the image went through.
    expect(response.headers.get('x-rutekit-degraded')).toBeNull();
    expect(new URL(calls[0]?.url ?? '').host).toBe('api.openai.com');
    expect(JSON.stringify(sentBody(calls).messages)).toContain('image_url');
  });

  it('falls back to the incapable entry with the cost stated, rather than swapping models', async () => {
    // OpenAI is down; the Groq entry is the only one left and it cannot see images.
    const { fetcher, calls } = responder((call) =>
      call.url.includes('api.openai.com')
        ? jsonResponse({ error: { message: 'upstream exploded' } }, 500)
        : jsonResponse({ ...OPENAI_COMPLETION, model: 'llama-3.1-8b-instant' }),
    );
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'groq', GROQ_KEY);
    addAccount(server, box, 'openai', OPENAI_KEY);
    addCombo(server, {
      name: 'chain',
      entries: [{ model: 'llama-3.1-8b-instant' }, { model: 'gpt-4o' }],
    });
    const secret = mintKey(server);

    const response = await post(app, { model: 'chain', ...IMAGE_TURN }, secret);

    expect(response.status).toBe(200);
    // Both entries were tried, and the second one is the model the operator
    // actually listed — reached with its cost stated, not replaced by a third.
    expect(calls.map((call) => new URL(call.url).host)).toEqual([
      'api.openai.com',
      'api.groq.com',
    ]);
    expect(response.headers.get('x-rutekit-degraded')).toBe('vision');
    expect(JSON.stringify(sentBody(calls, 1).messages)).toContain('[image omitted:');
  });

  it('keeps the operator’s order when no entry can express the request', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(OPENAI_COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'groq', GROQ_KEY);
    addCombo(server, {
      name: 'chain',
      entries: [{ model: 'llama-3.1-8b-instant' }, { model: 'llama-3.3-70b-versatile' }],
    });
    const secret = mintKey(server);

    const response = await post(app, { model: 'chain', ...IMAGE_TURN }, secret);

    expect(response.status).toBe(200);
    // Neither sees images. Reordering would be noise and swapping in a model the
    // operator never listed would be the thing FR-1.6 forbids, so the first entry
    // is used and degraded.
    expect(calls).toHaveLength(1);
    expect(sentBody(calls).model).toBe('llama-3.1-8b-instant');
    expect(response.headers.get('x-rutekit-degraded')).toBe('vision');
  });
});

describe('an embedding model', () => {
  it('is refused locally, without calling any provider', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(OPENAI_COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    const response = await post(
      app,
      { model: 'text-embedding-3-large', messages: [{ role: 'user', content: 'Hi' }] },
      secret,
    );

    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.kind).toBe('invalid_request');
    // Detected before the call, so no quota was spent and the message can name the
    // model rather than relay whatever the provider said about it.
    expect(error.message).toContain('text-embedding-3-large');
    expect(error.message).toContain('embedding');
    expect(calls).toHaveLength(0);
  });

  it('is skipped inside a combo rather than failing the turn', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(OPENAI_COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addCombo(server, {
      name: 'mixed',
      entries: [{ model: 'text-embedding-3-large' }, { model: 'gpt-4o' }],
    });
    const secret = mintKey(server);

    const response = await post(
      app,
      { model: 'mixed', messages: [{ role: 'user', content: 'Hi' }] },
      secret,
    );

    expect(response.status).toBe(200);
    // One entry was the wrong kind of model; the chain still served the turn.
    expect(calls).toHaveLength(1);
    expect(sentBody(calls).model).toBe('gpt-4o');
  });

  it('names the model when a combo has nothing but embedding entries', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(OPENAI_COMPLETION));
    const { server, app } = harness({ fetcher });
    addCombo(server, { name: 'vectors', entries: [{ model: 'text-embedding-3-large' }] });
    const secret = mintKey(server);

    const response = await post(
      app,
      { model: 'vectors', messages: [{ role: 'user', content: 'Hi' }] },
      secret,
    );

    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.kind).toBe('invalid_request');
    expect(error.message).toContain('embedding');
    expect(calls).toHaveLength(0);
  });
});

describe('a thinking budget', () => {
  it('is dropped for a model without reasoning, and reported', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(OPENAI_COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Think hard.' }],
        thinking: { type: 'enabled', budget_tokens: 2048 },
      }),
    });

    expect(response.status).toBe(200);
    // `gpt-4o` does not declare reasoning, so the budget is not something it can
    // honour — and the request that reaches it carries no trace of one.
    expect(response.headers.get('x-rutekit-degraded')).toBe('thinking');
    expect(sentBody(calls)).not.toHaveProperty('thinking');
  });

  it('is kept for a model that declares reasoning', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(OPENAI_COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    const secret = mintKey(server);

    const response = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        model: 'o3',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Think hard.' }],
        thinking: { type: 'enabled', budget_tokens: 2048 },
      }),
    });

    expect(response.status).toBe(200);
    // `o3` declares reasoning, so nothing was dropped and the provider sees the
    // budget the client asked for.
    expect(response.headers.get('x-rutekit-degraded')).toBeNull();
    expect(sentBody(calls)).toHaveProperty('thinking');
  });
});
