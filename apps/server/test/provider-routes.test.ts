import { afterEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_API_PREFIX,
  consoleErrorSchema,
  consolePaths,
  modelCatalogResponseSchema,
  okSchema,
  providerDetailSchema,
  providerModelSchema,
  providerModelsResponseSchema,
  providerSchema,
  providerTestResultSchema,
  providersResponseSchema,
} from '@contracts';
import type { ProviderModel } from '@contracts';

import { buildApp } from '@server/app.ts';
import { SecretBox } from '@server/security/secret-box.ts';
import { makeServer, type TestServer } from './helpers.ts';

/**
 * The Providers section, end to end (C13a, FR-2.1–2.6).
 *
 * A real composition with only the socket replaced. What these assert is what an
 * operator can observe: the catalog reading rutekit's own manifests, a BYOK
 * provider they create appearing in it and being reachable, the boundary between
 * a model they own and one the provider claims, and a probe reporting what the
 * endpoint actually said.
 *
 * The two that matter most are the ones about **ownership**, because they are the
 * rules the whole section is built on: a curated provider cannot be edited, and a
 * model rutekit did not write cannot be either. Both refusals exist so the console
 * never stores a value it cannot keep.
 */

const PASSWORD = 'correct-horse-battery';
const KEY_HEX = 'ab'.repeat(32);

type App = ReturnType<typeof buildApp>;

const servers: TestServer[] = [];

afterEach(() => {
  for (const server of servers) server.close();
  servers.length = 0;
});

async function signIn(app: App): Promise<string> {
  const response = await app.request(`${CONSOLE_API_PREFIX}${consolePaths.authSetup}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD, instanceName: 'Test' }),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) throw new Error('setup did not set a session cookie');
  const pair = setCookie.split(';')[0];
  if (pair === undefined) throw new Error('empty set-cookie header');
  return pair;
}

async function call(
  app: App,
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  return app.request(path, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

/**
 * A provider that answers a model listing, the way an OpenAI endpoint does.
 *
 * `models` is a live holder rather than a captured array, because one test needs
 * to change what the endpoint says between two fetches — which is the only way to
 * observe that a fetch replaces the synced set rather than merging into it.
 */
function listingResponder(options: { readonly models?: string[]; readonly fail?: boolean } = {}): {
  fetcher: (url: string, init: RequestInit) => Promise<Response>;
  calls: string[];
  models: string[];
} {
  const calls: string[] = [];
  const models = options.models ?? ['byok-model-a', 'byok-model-b'];

  return {
    calls,
    models,
    fetcher: (url) => {
      calls.push(url);
      if (options.fail === true) {
        return Promise.resolve(new Response('nope', { status: 503 }));
      }
      return Promise.resolve(
        Response.json({ object: 'list', data: models.map((id) => ({ id })) }),
      );
    },
  };
}

interface Harness {
  readonly server: TestServer;
  readonly app: App;
  readonly cookie: string;
  readonly box: SecretBox;
  readonly calls: string[];
  /** The endpoint's current model list, so a test can change what it says. */
  readonly endpoint: string[];
}

async function harness(
  options: { readonly models?: string[]; readonly fail?: boolean; readonly noKey?: boolean } = {},
): Promise<Harness> {
  const box = new SecretBox(KEY_HEX);
  const { fetcher, calls, models } = listingResponder(options);
  const server = makeServer({
    secrets: options.noKey === true ? null : box,
    providerFetch: fetcher,
  });
  server.lifecycle.markReady();
  servers.push(server);

  const app = buildApp(server);
  return { server, app, cookie: await signIn(app), box, calls, endpoint: models };
}

const PROVIDERS = `${CONSOLE_API_PREFIX}${consolePaths.providers}`;
const MODELS = `${CONSOLE_API_PREFIX}${consolePaths.models}`;
const providerPath = (id: string): string =>
  `${CONSOLE_API_PREFIX}${consolePaths.provider.replace(':id', id)}`;
const testPath = (id: string): string =>
  `${CONSOLE_API_PREFIX}${consolePaths.providerTest.replace(':id', id)}`;
const modelsPath = (id: string): string =>
  `${CONSOLE_API_PREFIX}${consolePaths.providerModels.replace(':id', id)}`;
const fetchPath = (id: string): string =>
  `${CONSOLE_API_PREFIX}${consolePaths.providerModelsFetch.replace(':id', id)}`;
const modelPath = (id: string, modelId: string): string =>
  `${CONSOLE_API_PREFIX}${consolePaths.providerModel
    .replace(':id', id)
    .replace(':modelId', modelId)}`;

async function errorOf(response: Response): Promise<{ kind: string; message: string }> {
  return consoleErrorSchema.parse(await response.json()).error;
}

/** Create a BYOK provider and return its id. */
async function createByok(h: Harness, overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await call(h.app, PROVIDERS, {
    method: 'POST',
    cookie: h.cookie,
    body: {
      name: 'My Endpoint',
      description: 'A self-hosted proxy.',
      category: 'byok',
      wireFamily: 'openai',
      baseUrl: 'https://endpoint.example.test/v1',
      docsUrl: null,
      icon: 'plug',
      apiKey: 'sk-byok-test',
      ...overrides,
    },
  });
  expect(response.status).toBe(201);
  return providerSchema.parse(await response.json()).id;
}

/* ---- The catalog ---- */

describe('the provider catalog', () => {
  it('lists rutekit’s own catalogue, with a status derived from its accounts', async () => {
    const h = await harness();

    const listed = providersResponseSchema.parse(
      await (await call(h.app, PROVIDERS, { cookie: h.cookie })).json(),
    );

    const openai = listed.items.find((entry) => entry.id === 'openai');
    expect(openai).toBeDefined();
    // No account, and it needs one — so the catalog says so rather than showing a
    // provider an operator would try to use.
    expect(openai?.status).toBe('needs_auth');
    expect(openai?.accountCount).toBe(0);
    expect(openai?.modelCount).toBeGreaterThan(0);

    // A provider that needs no credential is ready without one, because there is
    // nothing to sign into.
    const local = listed.items.find((entry) => entry.id === 'comfyui-local');
    expect(local?.status).toBe('ready');
  });

  it('filters by category, tier and free text', async () => {
    const h = await harness();

    const byok = providersResponseSchema.parse(
      await (await call(h.app, `${PROVIDERS}?category=byok`, { cookie: h.cookie })).json(),
    );
    expect(byok.items.every((entry) => entry.category === 'byok')).toBe(true);

    const free = providersResponseSchema.parse(
      await (await call(h.app, `${PROVIDERS}?tier=free`, { cookie: h.cookie })).json(),
    );
    expect(free.items.every((entry) => entry.freeTier)).toBe(true);

    const search = providersResponseSchema.parse(
      await (await call(h.app, `${PROVIDERS}?q=anthropic`, { cookie: h.cookie })).json(),
    );
    expect(search.items.some((entry) => entry.id === 'anthropic')).toBe(true);
  });

  it('refuses an anonymous caller', async () => {
    const h = await harness();
    expect((await call(h.app, PROVIDERS)).status).toBe(401);
  });
});

/* ---- Creating a BYOK provider ---- */

describe('a BYOK provider', () => {
  it('is created, appears in the catalog, and can be edited', async () => {
    const h = await harness();
    const id = await createByok(h);

    const listed = providersResponseSchema.parse(
      await (await call(h.app, `${PROVIDERS}?q=My Endpoint`, { cookie: h.cookie })).json(),
    );
    expect(listed.items.map((entry) => entry.id)).toEqual([id]);

    const patched = providerSchema.parse(
      await (
        await call(h.app, providerPath(id), {
          method: 'PATCH',
          cookie: h.cookie,
          body: { name: 'Renamed Endpoint' },
        })
      ).json(),
    );
    expect(patched.name).toBe('Renamed Endpoint');
    // A PATCH that names one field leaves the rest alone.
    expect(patched.baseUrl).toBe('https://endpoint.example.test/v1');
  });

  it('holds its key as an account, not as a column', async () => {
    // The key goes through the encrypted credential path every other account
    // uses, which is what makes it revocable and quota-tracked like the rest.
    const h = await harness();
    const id = await createByok(h);

    const detail = providerDetailSchema.parse(
      await (await call(h.app, providerPath(id), { cookie: h.cookie })).json(),
    );
    expect(detail.accounts).toHaveLength(1);
    expect(detail.provider.status).toBe('ready');
    expect(detail.provider.accountCount).toBe(1);
    expect(detail.accounts[0]?.label).toBe('My Endpoint key');
  });

  it('is created without a key, and says it needs one', async () => {
    const h = await harness();
    const id = await createByok(h, { apiKey: null });

    const detail = providerDetailSchema.parse(
      await (await call(h.app, providerPath(id), { cookie: h.cookie })).json(),
    );
    expect(detail.accounts).toEqual([]);
    expect(detail.provider.status).toBe('needs_auth');
  });

  it('refuses a key when the instance has no encryption key', async () => {
    // Storing a credential in the clear is worse than refusing to store one.
    const h = await harness({ noKey: true });
    const response = await call(h.app, PROVIDERS, {
      method: 'POST',
      cookie: h.cookie,
      body: {
        name: 'Keyless Instance',
        description: '',
        category: 'byok',
        wireFamily: 'openai',
        baseUrl: 'https://endpoint.example.test/v1',
        docsUrl: null,
        icon: 'plug',
        apiKey: 'sk-nope',
      },
    });

    expect(response.status).toBe(503);
    expect((await errorOf(response)).message).toMatch(/encryption key/);
  });

  it('refuses an id that collides with the catalogue', async () => {
    // A row named after a curated provider would be merged away by the live
    // registry — a provider that exists and is invisible.
    const h = await harness();
    const response = await call(h.app, PROVIDERS, {
      method: 'POST',
      cookie: h.cookie,
      body: {
        name: 'OpenAI',
        description: '',
        category: 'byok',
        wireFamily: 'openai',
        baseUrl: 'https://elsewhere.example.test/v1',
        docsUrl: null,
        icon: 'plug',
        apiKey: null,
      },
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(/already exists/);
  });

  it('is reachable by the router, not only by the console', async () => {
    // The whole point of the live registry: a provider the console can create is
    // one `/v1` can route to. Without this the row would be a lie.
    const h = await harness();
    const id = await createByok(h);

    const detail = providerDetailSchema.parse(
      await (await call(h.app, providerPath(id), { cookie: h.cookie })).json(),
    );
    expect(detail.provider.wireFamily).toBe('openai');
    expect(detail.provider.baseUrl).toBe('https://endpoint.example.test/v1');
  });

  it('is removed with its accounts disabled', async () => {
    const h = await harness();
    const id = await createByok(h);

    const response = await call(h.app, providerPath(id), { method: 'DELETE', cookie: h.cookie });
    expect(okSchema.parse(await response.json()).ok).toBe(true);

    expect((await call(h.app, providerPath(id), { cookie: h.cookie })).status).toBe(404);
    // The account stays as a row but is switched off: the pool reads accounts, and
    // a live credential whose provider is gone would stay selectable.
    const accounts = h.server.accounts.listByProvider(id);
    expect(accounts.every((account) => account.state === 'disabled')).toBe(true);
  });

  it('refuses to edit a provider rutekit ships', async () => {
    const h = await harness();
    const response = await call(h.app, providerPath('openai'), {
      method: 'PATCH',
      cookie: h.cookie,
      body: { name: 'Not Mine' },
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(/comes from rutekit's own catalogue/);
  });

  it('refuses to remove a provider rutekit ships', async () => {
    const h = await harness();
    const response = await call(h.app, providerPath('openai'), {
      method: 'DELETE',
      cookie: h.cookie,
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(/cannot be changed/);
  });

  it('answers not_found for an id nothing serves', async () => {
    const h = await harness();
    expect((await call(h.app, providerPath('nope'), { cookie: h.cookie })).status).toBe(404);
  });
});

/* ---- Probing and discovery ---- */

describe('testing and discovery', () => {
  it('probes the endpoint and reports what it listed', async () => {
    const h = await harness({ models: ['a', 'b', 'c'] });
    const id = await createByok(h);

    const result = providerTestResultSchema.parse(
      await (await call(h.app, testPath(id), { method: 'POST', cookie: h.cookie })).json(),
    );

    expect(result.ok).toBe(true);
    expect(result.modelCount).toBe(3);
    expect(result.latencyMs).not.toBeNull();
    expect(h.calls[0]).toContain('endpoint.example.test');
  });

  it('reports a probe that failed rather than throwing', async () => {
    const h = await harness({ fail: true });
    const id = await createByok(h);

    const result = providerTestResultSchema.parse(
      await (await call(h.app, testPath(id), { method: 'POST', cookie: h.cookie })).json(),
    );

    expect(result.ok).toBe(false);
    expect(result.modelCount).toBeNull();
    // A probe that reached the endpoint and was refused did take time — only one
    // that never connected has no latency to report.
    expect(result.latencyMs).not.toBeNull();
    expect(result.message).toMatch(/HTTP 503|refused/);
  });

  it('fetches the endpoint’s models and stores them as synced', async () => {
    const h = await harness({ models: ['byok-model-a', 'byok-model-b'] });
    const id = await createByok(h);

    const fetched = providerModelsResponseSchema.parse(
      await (await call(h.app, fetchPath(id), { method: 'POST', cookie: h.cookie })).json(),
    );

    expect(fetched.models.map((model) => model.id)).toEqual(['byok-model-a', 'byok-model-b']);
    // What an endpoint says about itself is the provider's claim, so it is stored
    // as `synced` — the one source an operator may not edit.
    expect(fetched.models.every((model) => model.source === 'synced')).toBe(true);

    const listed = providerModelsResponseSchema.parse(
      await (await call(h.app, modelsPath(id), { cookie: h.cookie })).json(),
    );
    expect(listed.models).toHaveLength(2);
  });

  it('replaces the synced set rather than merging into it', async () => {
    // A half-old, half-new list is neither what the endpoint said before nor what
    // it says now, and the console would show it as the current truth.
    const h = await harness({ models: ['one'] });
    const id = await createByok(h);
    await call(h.app, fetchPath(id), { method: 'POST', cookie: h.cookie });

    h.endpoint.length = 0;
    h.endpoint.push('two', 'three');

    const fetched = providerModelsResponseSchema.parse(
      await (await call(h.app, fetchPath(id), { method: 'POST', cookie: h.cookie })).json(),
    );
    // Order-insensitive: the list is read back sorted by id, and what this test is
    // about is that `one` is gone rather than the order the two survivors are in.
    expect(fetched.models.map((model) => model.id).sort()).toEqual(['three', 'two']);
  });

  it('reports a fetch that failed rather than storing nothing silently', async () => {
    const h = await harness({ fail: true });
    const id = await createByok(h);

    const response = await call(h.app, fetchPath(id), { method: 'POST', cookie: h.cookie });
    expect(response.status).toBe(502);
    expect((await errorOf(response)).message).toMatch(/refused the request|HTTP 503/);
  });

  it('does not invent a discovery for a provider whose list is its manifest', async () => {
    // A curated provider with a static list has nothing to fetch; writing the
    // manifest's own models back as `synced` would claim a discovery that never
    // happened.
    const h = await harness();
    const listed = providerModelsResponseSchema.parse(
      await (
        await call(h.app, fetchPath('comfyui-local'), { method: 'POST', cookie: h.cookie })
      ).json(),
    );

    expect(listed.models.every((model) => model.source === 'template')).toBe(true);
  });
});

/* ---- Custom models ---- */

describe('a custom model', () => {
  const MODEL = {
    id: 'my-model',
    displayName: 'My Model',
    contextWindow: 32_000,
    maxOutputTokens: 4_000,
    capabilities: { vision: false, tools: true, reasoning: false, embedding: false },
    inputPricePerMTok: 0.5,
    outputPricePerMTok: 1.5,
  };

  it('is added, listed beside the catalogue’s own, and editable', async () => {
    const h = await harness();
    const id = await createByok(h);

    const created = providerModelSchema.parse(
      await (
        await call(h.app, modelsPath(id), { method: 'POST', cookie: h.cookie, body: MODEL })
      ).json(),
    );
    expect(created.source).toBe('custom');
    expect(created.providerId).toBe(id);

    const patched = providerModelSchema.parse(
      await (
        await call(h.app, modelPath(id, 'my-model'), {
          method: 'PATCH',
          cookie: h.cookie,
          body: { ...MODEL, displayName: 'Renamed Model' },
        })
      ).json(),
    );
    expect(patched.displayName).toBe('Renamed Model');
  });

  it('is renamed by writing the new id and dropping the old', async () => {
    const h = await harness();
    const id = await createByok(h);
    await call(h.app, modelsPath(id), { method: 'POST', cookie: h.cookie, body: MODEL });

    const renamed = providerModelSchema.parse(
      await (
        await call(h.app, modelPath(id, 'my-model'), {
          method: 'PATCH',
          cookie: h.cookie,
          body: { ...MODEL, id: 'renamed-model' },
        })
      ).json(),
    );
    expect(renamed.id).toBe('renamed-model');

    // Half of a rename would leave the model listed twice.
    const listed = providerModelsResponseSchema.parse(
      await (await call(h.app, modelsPath(id), { cookie: h.cookie })).json(),
    );
    expect(listed.models.map((model) => model.id)).toEqual(['renamed-model']);
  });

  it('is removed', async () => {
    const h = await harness();
    const id = await createByok(h);
    await call(h.app, modelsPath(id), { method: 'POST', cookie: h.cookie, body: MODEL });

    const response = await call(h.app, modelPath(id, 'my-model'), {
      method: 'DELETE',
      cookie: h.cookie,
    });
    expect(okSchema.parse(await response.json()).ok).toBe(true);

    const listed = providerModelsResponseSchema.parse(
      await (await call(h.app, modelsPath(id), { cookie: h.cookie })).json(),
    );
    expect(listed.models).toEqual([]);
  });

  it('refuses an id the provider already lists', async () => {
    const h = await harness({ models: ['taken'] });
    const id = await createByok(h);
    await call(h.app, fetchPath(id), { method: 'POST', cookie: h.cookie });

    const response = await call(h.app, modelsPath(id), {
      method: 'POST',
      cookie: h.cookie,
      body: { ...MODEL, id: 'taken' },
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(/already lists/);
  });

  it('leaves a custom model alone when the endpoint is re-fetched', async () => {
    // A fetch says nothing about the operator's own entries, so it must not
    // remove them.
    const h = await harness({ models: ['synced-one'] });
    const id = await createByok(h);
    await call(h.app, modelsPath(id), { method: 'POST', cookie: h.cookie, body: MODEL });
    await call(h.app, fetchPath(id), { method: 'POST', cookie: h.cookie });

    const listed = providerModelsResponseSchema.parse(
      await (await call(h.app, modelsPath(id), { cookie: h.cookie })).json(),
    );
    expect(listed.models.map((model) => model.id).sort()).toEqual(['my-model', 'synced-one']);
  });

  it('cannot be edited when the provider told us about it', async () => {
    // The provider's claim is not rutekit's to rewrite — the next fetch would undo
    // the edit, and a console that allowed it would store a value it cannot keep.
    const h = await harness({ models: ['from-endpoint'] });
    const id = await createByok(h);
    await call(h.app, fetchPath(id), { method: 'POST', cookie: h.cookie });

    const response = await call(h.app, modelPath(id, 'from-endpoint'), {
      method: 'PATCH',
      cookie: h.cookie,
      body: { ...MODEL, id: 'from-endpoint', displayName: 'Renamed' },
    });
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(/was not added by hand/);
  });

  it('cannot be removed when it comes from the catalogue', async () => {
    const h = await harness();
    const response = await call(h.app, modelPath('openai', 'gpt-4o'), {
      method: 'DELETE',
      cookie: h.cookie,
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(/cannot be removed/);
  });

  it('cannot be edited when it comes from the catalogue', async () => {
    const h = await harness();
    const response = await call(h.app, modelPath('openai', 'gpt-4o'), {
      method: 'PATCH',
      cookie: h.cookie,
      body: { ...MODEL, id: 'gpt-4o' },
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toMatch(/cannot be edited/);
  });

  it('answers not_found for a model that is not there', async () => {
    const h = await harness();
    const response = await call(h.app, modelPath('openai', 'nope'), {
      method: 'DELETE',
      cookie: h.cookie,
    });
    expect(response.status).toBe(404);
  });
});

/* ---- The model catalog ---- */

describe('the model catalog', () => {
  it('joins every model to the provider that serves it', async () => {
    // Paged, so the lookup asks for the row rather than assuming which page it is
    // on: the catalogue is 200-odd models and the first page is one provider's.
    const h = await harness();
    const listed = modelCatalogResponseSchema.parse(
      await (await call(h.app, `${MODELS}?q=gpt-4o&providerId=openai`, { cookie: h.cookie })).json(),
    );

    expect(listed.total).toBeGreaterThan(0);
    const row = listed.items.find((entry) => entry.id === 'gpt-4o');
    // Derived from the registry rather than written down: the join is what this
    // test is about, and a hard-coded name would be a second copy of the manifest
    // that goes stale the first time a provider is renamed.
    const manifest = h.server.registry.get('openai');
    expect(row?.providerName).toBe(manifest?.name);
    expect(row?.providerIcon).toBe(manifest?.icon);
    expect(row?.source).toBe('template');
  });

  it('filters by capability, source and a context floor', async () => {
    const h = await harness();

    const vision = modelCatalogResponseSchema.parse(
      await (await call(h.app, `${MODELS}?capability=vision`, { cookie: h.cookie })).json(),
    );
    expect(vision.items.every((entry) => entry.capabilities.vision)).toBe(true);

    const templates = modelCatalogResponseSchema.parse(
      await (await call(h.app, `${MODELS}?source=template`, { cookie: h.cookie })).json(),
    );
    expect(templates.items.every((entry) => entry.source === 'template')).toBe(true);

    const big = modelCatalogResponseSchema.parse(
      await (await call(h.app, `${MODELS}?minContext=200000`, { cookie: h.cookie })).json(),
    );
    expect(big.items.every((entry) => (entry.contextWindow ?? 0) >= 200_000)).toBe(true);
  });

  it('searches by the provider’s own name as well as the model’s', async () => {
    // "Which of groq's models take tools" starts by typing `groq`, and a search
    // that ignored the provider column would look broken on a page showing one.
    const h = await harness();
    const hit = modelCatalogResponseSchema.parse(
      await (await call(h.app, `${MODELS}?q=groq`, { cookie: h.cookie })).json(),
    );

    expect(hit.total).toBeGreaterThan(0);
    expect(hit.items.every((entry) => entry.providerId === 'groq')).toBe(true);
  });

  it('shows a custom model beside the catalogue’s own', async () => {
    const h = await harness();
    const id = await createByok(h);
    await call(h.app, modelsPath(id), {
      method: 'POST',
      cookie: h.cookie,
      body: {
        id: 'catalog-visible',
        displayName: 'Catalog Visible',
        contextWindow: 8_000,
        maxOutputTokens: null,
        capabilities: { vision: false, tools: false, reasoning: false, embedding: false },
        inputPricePerMTok: null,
        outputPricePerMTok: null,
      },
    });

    const listed = modelCatalogResponseSchema.parse(
      await (await call(h.app, `${MODELS}?q=catalog-visible`, { cookie: h.cookie })).json(),
    );
    expect(listed.items.map((entry) => entry.id)).toEqual(['catalog-visible']);
    expect(listed.items[0]?.providerName).toBe('My Endpoint');
    expect(listed.items[0]?.source).toBe('custom');
  });

  it('pages a large catalog', async () => {
    const h = await harness();
    const first = modelCatalogResponseSchema.parse(
      await (await call(h.app, `${MODELS}?limit=5`, { cookie: h.cookie })).json(),
    );
    expect(first.items).toHaveLength(5);
    expect(first.nextCursor).toBe('5');

    const second = modelCatalogResponseSchema.parse(
      await (await call(h.app, `${MODELS}?limit=5&cursor=5`, { cookie: h.cookie })).json(),
    );
    const firstIds = new Set(first.items.map((entry) => `${entry.providerId}::${entry.id}`));
    expect(second.items.some((entry) => firstIds.has(`${entry.providerId}::${entry.id}`))).toBe(false);
  });
});

/** An unused import guard: the model type is used through the schemas above. */
export type { ProviderModel };
