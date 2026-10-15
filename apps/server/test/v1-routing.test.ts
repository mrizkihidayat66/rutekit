import { afterEach, describe, expect, it } from 'vitest';
import { modelsResponseSchema, openAiErrorSchema } from '@contracts';
import type { ApiKeyInput } from '@contracts';

import { buildApp } from '@server/app.ts';
import type { ResponseFetcher } from '@server/providers/outbound.ts';
import { SecretBox } from '@server/security/secret-box.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The data plane under a plan (C5b, FR-1.3–1.5).
 *
 * `v1-dispatch.test.ts` covers one turn to one model. This file covers what C5b
 * added around it: a client naming an alias, a combo or a mapped id, and the
 * chain a combo is allowed to walk when a candidate fails.
 *
 * The fallback boundary is the thing worth pinning. A combo may retry while the
 * client has been told nothing — that is what `callProvider` returning on headers
 * buys — and the tests below assert both halves: an entry that fails before its
 * headers hands the turn to the next one, and `fallbackOnError: false` does not.
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

const OPENAI_COMPLETION = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'gpt-4o-mini',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

/** OpenAI answers with a 500; Anthropic answers normally. */
function openAiDown(): { fetcher: ResponseFetcher; calls: Call[] } {
  return responder((call) =>
    call.url.includes('api.openai.com')
      ? jsonResponse({ error: { message: 'upstream exploded' } }, 500)
      : jsonResponse(ANTHROPIC_MESSAGE),
  );
}

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

const TURN = { messages: [{ role: 'user', content: 'Hi' }] } as const;

function addAlias(
  server: TestServer,
  input: { alias: string; target: string; providerId?: string | null; enabled?: boolean },
): void {
  const at = new Date().toISOString();
  server.aliases.create({
    id: crypto.randomUUID(),
    alias: input.alias,
    target: input.target,
    providerId: input.providerId ?? null,
    enabled: input.enabled ?? true,
    description: null,
    createdAt: at,
    updatedAt: at,
  });
}

function addCombo(
  server: TestServer,
  input: {
    name: string;
    strategy?: 'sequential' | 'round_robin';
    fallbackOnError?: boolean;
    enabled?: boolean;
    entries: { model: string; providerId?: string | null }[];
  },
): void {
  const at = new Date().toISOString();
  server.combos.create(
    {
      id: crypto.randomUUID(),
      name: input.name,
      displayName: input.name,
      description: null,
      strategy: input.strategy ?? 'sequential',
      fallbackOnError: input.fallbackOnError ?? true,
      enabled: input.enabled ?? true,
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

function addMapping(
  server: TestServer,
  input: { match: 'exact' | 'contains' | 'regex'; pattern: string; replacement: string },
): void {
  const at = new Date().toISOString();
  server.mappings.create({
    id: crypto.randomUUID(),
    match: input.match,
    pattern: input.pattern,
    replacement: input.replacement,
    priority: 0,
    enabled: true,
    description: null,
    createdAt: at,
    updatedAt: at,
  });
}

describe('an alias as the model name', () => {
  it('sends the turn to the model the alias names', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(OPENAI_COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addAlias(server, { alias: 'fast', target: 'gpt-4o-mini' });
    const secret = mintKey(server);

    const response = await post(app, { model: 'fast', ...TURN }, secret);

    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    // The provider is called with its own id, not the alias the client sent.
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ model: 'gpt-4o-mini' });
  });

  it('lets a key allowed only the alias use it', async () => {
    const { fetcher } = responder(() => jsonResponse(OPENAI_COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addAlias(server, { alias: 'fast', target: 'gpt-4o-mini' });
    const secret = mintKey(server, { modelsAllowed: ['fast'] });

    const response = await post(app, { model: 'fast', ...TURN }, secret);

    expect(response.status).toBe(200);
  });

  it('refuses when the key denies the model behind the alias', async () => {
    const { fetcher } = responder(() => jsonResponse(OPENAI_COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addAlias(server, { alias: 'fast', target: 'gpt-4o-mini' });
    const secret = mintKey(server, { modelsDenied: ['gpt-4o-mini'] });

    const response = await post(app, { model: 'fast', ...TURN }, secret);

    // The deny is matched against both names the candidate has. Without that, an
    // alias would be a way around the denylist rather than a name for a model.
    expect(response.status).toBe(403);
    expect((await errorOf(response)).kind).toBe('permission');
  });
});

describe('a combo as the model name', () => {
  it('walks to the next entry when the first fails before its headers', async () => {
    const { fetcher, calls } = openAiDown();
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addAccount(server, box, 'anthropic', ANTHROPIC_KEY);
    addCombo(server, {
      name: 'daily',
      entries: [{ model: 'gpt-4o-mini' }, { model: 'claude-3-opus-20240229' }],
    });
    const secret = mintKey(server);

    const response = await post(app, { model: 'daily', ...TURN }, secret);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { object: string; choices: unknown[] };
    expect(body.object).toBe('chat.completion');
    expect(body.choices).toHaveLength(1);
    // Two upstream calls: the OpenAI one failed, the Anthropic one answered.
    expect(calls.map((call) => new URL(call.url).host)).toEqual([
      'api.openai.com',
      'api.anthropic.com',
    ]);
  });

  it('skips an entry whose provider has no usable account', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(ANTHROPIC_MESSAGE));
    const { server, app, box } = harness({ fetcher });
    // No OpenAI account at all, so the pool answers null for that provider.
    addAccount(server, box, 'anthropic', ANTHROPIC_KEY);
    addCombo(server, {
      name: 'daily',
      entries: [{ model: 'gpt-4o-mini' }, { model: 'claude-3-opus-20240229' }],
    });
    const secret = mintKey(server);

    const response = await post(app, { model: 'daily', ...TURN }, secret);

    expect(response.status).toBe(200);
    // Nothing was sent to a provider that could not take the turn, so only one
    // call was made — the fallback cost no quota.
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]?.url ?? '').host).toBe('api.anthropic.com');
  });

  it('does not walk when fallbackOnError is off', async () => {
    const { fetcher, calls } = openAiDown();
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addAccount(server, box, 'anthropic', ANTHROPIC_KEY);
    addCombo(server, {
      name: 'strict',
      fallbackOnError: false,
      entries: [{ model: 'gpt-4o-mini' }, { model: 'claude-3-opus-20240229' }],
    });
    const secret = mintKey(server);

    const response = await post(app, { model: 'strict', ...TURN }, secret);

    expect(response.status).toBe(502);
    expect((await errorOf(response)).kind).toBe('upstream_error');
    // Fail fast means one attempt: the second entry was never tried.
    expect(calls).toHaveLength(1);
  });

  it('fails fast on an unavailable first entry too', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(ANTHROPIC_MESSAGE));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'anthropic', ANTHROPIC_KEY);
    addCombo(server, {
      name: 'strict',
      fallbackOnError: false,
      entries: [{ model: 'gpt-4o-mini' }, { model: 'claude-3-opus-20240229' }],
    });
    const secret = mintKey(server);

    const response = await post(app, { model: 'strict', ...TURN }, secret);

    expect(response.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('skips an entry the key may not use, and uses the next one', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(ANTHROPIC_MESSAGE));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addAccount(server, box, 'anthropic', ANTHROPIC_KEY);
    addCombo(server, {
      name: 'daily',
      entries: [{ model: 'gpt-4o-mini' }, { model: 'claude-3-opus-20240229' }],
    });
    const secret = mintKey(server, { modelsDenied: ['gpt-4o-mini'] });

    const response = await post(app, { model: 'daily', ...TURN }, secret);

    expect(response.status).toBe(200);
    // The out-of-scope entry is filtered out of the plan rather than failing the
    // turn, so the chain simply starts at the entry the key may use.
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]?.url ?? '').host).toBe('api.anthropic.com');
  });

  it('names the stale entries when a combo has nothing usable', async () => {
    const { fetcher } = responder(() => jsonResponse({}));
    const { server, app } = harness({ fetcher });
    addCombo(server, { name: 'broken', entries: [{ model: 'gone-a' }, { model: 'gone-b' }] });
    const secret = mintKey(server);

    const response = await post(app, { model: 'broken', ...TURN }, secret);

    expect(response.status).toBe(503);
    const error = await errorOf(response);
    expect(error.kind).toBe('unavailable');
    // A configuration fault, not a missing model: the message has to say which
    // entries are stale or the operator has no way to fix it.
    expect(error.message).toContain('gone-a');
    expect(error.message).toContain('gone-b');
  });

  it('answers not_found for a disabled combo', async () => {
    const { fetcher } = responder(() => jsonResponse({}));
    const { server, app } = harness({ fetcher });
    addCombo(server, { name: 'off', enabled: false, entries: [{ model: 'gpt-4o-mini' }] });
    const secret = mintKey(server);

    const response = await post(app, { model: 'off', ...TURN }, secret);

    expect(response.status).toBe(404);
    expect((await errorOf(response)).kind).toBe('not_found');
  });
});

describe('model mapping at the edge', () => {
  it('rewrites the id before anything resolves it', async () => {
    const { fetcher, calls } = responder(() => jsonResponse(OPENAI_COMPLETION));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'openai', OPENAI_KEY);
    addMapping(server, {
      match: 'exact',
      pattern: 'gpt-4o',
      replacement: 'gpt-4o-mini',
    });
    const secret = mintKey(server);

    const response = await post(app, { model: 'gpt-4o', ...TURN }, secret);

    expect(response.status).toBe(200);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toMatchObject({ model: 'gpt-4o-mini' });
  });

  it('lets a mapping point at a combo', async () => {
    const { fetcher } = responder(() => jsonResponse(ANTHROPIC_MESSAGE));
    const { server, app, box } = harness({ fetcher });
    addAccount(server, box, 'anthropic', ANTHROPIC_KEY);
    addCombo(server, { name: 'daily', entries: [{ model: 'claude-3-opus-20240229' }] });
    addMapping(server, { match: 'exact', pattern: 'quick', replacement: 'daily' });
    const secret = mintKey(server);

    const response = await post(app, { model: 'quick', ...TURN }, secret);

    expect(response.status).toBe(200);
  });
});

describe('/v1/models with a plan', () => {
  it('lists aliases and combos alongside the curated models', async () => {
    const { fetcher } = responder(() => jsonResponse({}));
    const { server, app } = harness({ fetcher });
    addAlias(server, { alias: 'fast', target: 'gpt-4o-mini' });
    addCombo(server, { name: 'daily', entries: [{ model: 'gpt-4o-mini' }] });
    const secret = mintKey(server);

    const response = await app.request('/v1/models', {
      headers: { authorization: `Bearer ${secret}` },
    });
    const listing = modelsResponseSchema.parse(await response.json());
    const byId = new Map(listing.data.map((model) => [model.id, model]));

    // The curated model now says which alias reaches it, which is how a client
    // that discovered `gpt-4o-mini` learns that `fast` means the same thing.
    expect(byId.get('gpt-4o-mini')?.rutekit?.alias).toBe('fast');
    // The alias is a name a client can send, so it is discoverable in its own right.
    expect(byId.get('fast')?.owned_by).toBe('openai');
    expect(byId.get('fast')?.rutekit?.contextWindow).toBe(
      byId.get('gpt-4o-mini')?.rutekit?.contextWindow,
    );
    // A combo is rutekit's own construct with no single provider behind it, so it
    // gets a row and no extension block rather than a made-up one.
    expect(byId.get('daily')?.owned_by).toBe('rutekit');
    expect(byId.get('daily')?.rutekit).toBeUndefined();
  });

  it('leaves out an alias that resolves to nothing', async () => {
    const { fetcher } = responder(() => jsonResponse({}));
    const { server, app } = harness({ fetcher });
    addAlias(server, { alias: 'stale', target: 'no-such-model' });
    const secret = mintKey(server);

    const response = await app.request('/v1/models', {
      headers: { authorization: `Bearer ${secret}` },
    });
    const listing = modelsResponseSchema.parse(await response.json());

    // Advertising a name that would answer 404 is worse than not advertising it.
    expect(listing.data.map((model) => model.id)).not.toContain('stale');
  });

  it('leaves out a disabled alias and a disabled combo', async () => {
    const { fetcher } = responder(() => jsonResponse({}));
    const { server, app } = harness({ fetcher });
    addAlias(server, { alias: 'off', target: 'gpt-4o-mini', enabled: false });
    addCombo(server, { name: 'off-combo', enabled: false, entries: [{ model: 'gpt-4o-mini' }] });
    const secret = mintKey(server);

    const response = await app.request('/v1/models', {
      headers: { authorization: `Bearer ${secret}` },
    });
    const listing = modelsResponseSchema.parse(await response.json());
    const ids = listing.data.map((model) => model.id);

    expect(ids).not.toContain('off');
    expect(ids).not.toContain('off-combo');
  });

  it('reports a curated model with no alias as null rather than omitting the field', async () => {
    const { fetcher } = responder(() => jsonResponse({}));
    const { server, app } = harness({ fetcher });
    const secret = mintKey(server);

    const response = await app.request('/v1/models', {
      headers: { authorization: `Bearer ${secret}` },
    });
    const listing = modelsResponseSchema.parse(await response.json());
    const model = listing.data.find((entry) => entry.id === 'gpt-4o');

    expect(model?.rutekit?.alias).toBeNull();
  });
});
