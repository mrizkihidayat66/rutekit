import { describe, expect, it } from 'vitest';

import { classifyFailure } from '../src/classify.ts';
import { listModels, testConnection } from '../src/discovery.ts';
import { parseListing } from '../src/listing.ts';
import type { ProviderManifest } from '../src/manifest.ts';
import { providerManifestSchema } from '../src/manifest.ts';
import { openai } from '../src/providers/openai.ts';
import { providerManifests } from '../src/providers/index.ts';
import { createProviderRegistry } from '../src/registry.ts';
import {
  applyAuth,
  endpointUrl,
  resolveTemplate,
  type Fetcher,
  type HttpRequest,
} from '../src/transport.ts';

const registry = createProviderRegistry(providerManifests);

const manifest = (id: string): ProviderManifest => {
  const found = registry.get(id);
  if (found === undefined) throw new Error(`the catalogue has no provider '${id}'`);
  return found;
};

/** A manifest built from a real one, for the rules no shipped provider carries. */
const withErrors = (errors: unknown): ProviderManifest =>
  providerManifestSchema.parse({ ...openai, errors });

interface Call {
  readonly url: string;
  readonly init: HttpRequest;
}

const jsonResponse = (status: number, body: unknown) => ({
  status,
  text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
});

/** A fetcher that answers once and remembers what it was asked. */
function recorder(reply: { status: number; text: () => Promise<string> }) {
  const calls: Call[] = [];
  const fetch: Fetcher = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(reply);
  };
  return { fetch, calls };
}

const failingFetch =
  (error: Error): Fetcher =>
  () =>
    Promise.reject(error);

describe('classifyFailure', () => {
  const provider = manifest('openai');

  it('reads a bare 429 as a rate limit', () => {
    expect(classifyFailure(provider, { status: 429, body: '' })?.class).toBe('rate_limit');
  });

  it('reads the same 429 as a spent quota when the body says so', () => {
    const signal = { status: 429, body: '{"error":{"code":"insufficient_quota"}}' };
    expect(classifyFailure(provider, signal)?.class).toBe('quota');
  });

  it('matches the body case-insensitively', () => {
    const signal = { status: 429, body: 'INSUFFICIENT_QUOTA' };
    expect(classifyFailure(provider, signal)?.class).toBe('quota');
  });

  it('reads a rejected key as auth', () => {
    expect(classifyFailure(provider, { status: 401, body: '' })?.class).toBe('auth');
    expect(classifyFailure(provider, { status: 403, body: '' })?.class).toBe('auth');
  });

  it('reads an overloaded upstream as transient', () => {
    expect(classifyFailure(manifest('anthropic'), { status: 529, body: '' })?.class).toBe(
      'transient',
    );
  });

  it('says nothing about a status no rule covers', () => {
    expect(classifyFailure(provider, { status: 418, body: 'teapot' })).toBeNull();
  });

  it('lets a pattern-only rule fire on a 200', () => {
    const custom = withErrors([{ class: 'quota', matches: ['out of credit'] }]);
    expect(classifyFailure(custom, { status: 200, body: '{"error":"out of credit"}' })?.class).toBe(
      'quota',
    );
    expect(classifyFailure(custom, { status: 200, body: '{"ok":true}' })).toBeNull();
  });

  it('carries the rule it matched and the scope it declared', () => {
    const custom = withErrors([{ class: 'rate_limit', scope: 'egress', statuses: [429] }]);
    const failure = classifyFailure(custom, { status: 429, body: '' });
    expect(failure?.scope).toBe('egress');
    expect(failure?.rule.statuses).toEqual([429]);
  });

  it('takes the first matching rule, so order is load-bearing', () => {
    const custom = withErrors([
      { class: 'quota', statuses: [429], matches: ['quota'] },
      { class: 'rate_limit', statuses: [429] },
    ]);
    expect(classifyFailure(custom, { status: 429, body: 'quota' })?.class).toBe('quota');
    expect(classifyFailure(custom, { status: 429, body: 'nope' })?.class).toBe('rate_limit');
  });
});

describe('resolveTemplate', () => {
  it('substitutes every placeholder it is given', () => {
    expect(
      resolveTemplate('https://{region}.example.com/{project}', { region: 'eu', project: 'p' }),
    ).toEqual({ url: 'https://eu.example.com/p', missing: [] });
  });

  it('collects every missing name rather than stopping at the first', () => {
    const resolved = resolveTemplate('https://{region}.example.com/{project}', {});
    expect(resolved.missing).toEqual(['region', 'project']);
  });

  it('treats an empty value as missing', () => {
    expect(resolveTemplate('a/{x}/b', { x: '' }).missing).toEqual(['x']);
  });
});

describe('endpointUrl', () => {
  it('joins a path onto a literal base without doubling the slash', () => {
    expect(endpointUrl(manifest('openai'), '/models').url).toBe('https://api.openai.com/v1/models');
  });

  it('returns the bare base when there is no path', () => {
    expect(endpointUrl(manifest('comfyui-local'), null).url).toBe('http://127.0.0.1:8188');
  });

  it('assembles Vertex from the account values and reports what is missing', () => {
    const vertex = manifest('google-vertex');
    const complete = endpointUrl(vertex, '/publishers/google/models', {
      region: 'us-east5',
      project: 'my-project',
    });
    expect(complete.url).toBe(
      'https://us-east5-aiplatform.googleapis.com/v1/projects/my-project/locations/us-east5/publishers/google/models',
    );
    expect(complete.missing).toEqual([]);

    expect(endpointUrl(vertex, null, {}).missing).toEqual(['region', 'project']);
  });

  it('appends a static query parameter', () => {
    const custom = providerManifestSchema.parse({
      ...openai,
      endpoint: { ...openai.endpoint, queryParams: { 'api-version': '2024-01-01' } },
    });
    expect(endpointUrl(custom, '/models').url).toContain('api-version=2024-01-01');
  });

  it('places a region in the query when the manifest says so', () => {
    const custom = providerManifestSchema.parse({
      ...openai,
      endpoint: {
        ...openai.endpoint,
        regions: { values: ['eu', 'us'], default: 'eu', placement: 'query', param: 'location' },
      },
    });
    expect(endpointUrl(custom, '/models').url).toContain('location=eu');
    expect(endpointUrl(custom, '/models', { region: 'us' }).url).toContain('location=us');
  });
});

describe('applyAuth', () => {
  it('sends a bearer scheme when the manifest names one', () => {
    expect(applyAuth(manifest('openai'), 'sk-1')).toEqual({
      headers: { Authorization: 'Bearer sk-1' },
      query: {},
    });
  });

  it('sends a raw key when the scheme is null', () => {
    expect(applyAuth(manifest('anthropic'), 'sk-2').headers).toEqual({ 'x-api-key': 'sk-2' });
  });

  it('sends nothing for a provider with no credential', () => {
    expect(applyAuth(manifest('comfyui-local'), null)).toEqual({ headers: {}, query: {} });
    expect(applyAuth(manifest('openai'), null)).toEqual({ headers: {}, query: {} });
  });

  it('puts the key in the query when the mode says queryParam', () => {
    const custom = providerManifestSchema.parse({
      ...openai,
      authModes: [{ mode: 'api-key', header: 'x-goog-api-key', queryParam: 'key' }],
    });
    expect(applyAuth(custom, 'k')).toEqual({ headers: {}, query: { key: 'k' } });
  });

  it('sends a cookie as the cookie header', () => {
    const custom = providerManifestSchema.parse({
      ...openai,
      authModes: [{ mode: 'cookie', cookieName: 'sso' }],
    });
    expect(applyAuth(custom, 'abc').headers).toEqual({ Cookie: 'sso=abc' });
  });

  it('sends a bearer for a service account', () => {
    expect(applyAuth(manifest('google-vertex'), 'token').headers).toEqual({
      Authorization: 'Bearer token',
    });
  });
});

describe('parseListing', () => {
  it('reads the OpenAI-shaped envelope', () => {
    expect(parseListing('openai', '{"data":[{"id":"a"},{"id":"b"}]}')).toEqual([
      { id: 'a', displayName: null, contextWindow: null, maxOutputTokens: null },
      { id: 'b', displayName: null, contextWindow: null, maxOutputTokens: null },
    ]);
  });

  it('reads Anthropic display names when they are there', () => {
    expect(parseListing('anthropic', '{"data":[{"id":"m","display_name":"M"}]}')).toEqual([
      { id: 'm', displayName: 'M', contextWindow: null, maxOutputTokens: null },
    ]);
  });

  it('strips the models/ prefix Google puts on every name', () => {
    expect(
      parseListing(
        'google',
        '{"models":[{"name":"models/g","displayName":"G","inputTokenLimit":100,"outputTokenLimit":20}]}',
      ),
    ).toEqual([{ id: 'g', displayName: 'G', contextWindow: 100, maxOutputTokens: 20 }]);
  });

  it('answers null for a body that is not JSON', () => {
    expect(parseListing('openai', '<html>nope</html>')).toBeNull();
  });

  it('answers null for JSON in the wrong shape', () => {
    expect(parseListing('openai', '{"models":[]}')).toBeNull();
    expect(parseListing('openai', '{"data":[{"name":"a"}]}')).toBeNull();
  });

  it('answers null for an empty list that is the right shape, and it is not null', () => {
    expect(parseListing('openai', '{"data":[]}')).toEqual([]);
  });
});

describe('listModels', () => {
  it('never calls the endpoint for a static provider', async () => {
    const { fetch, calls } = recorder(jsonResponse(200, {}));
    const result = await listModels(manifest('comfyui-local'), { fetch });
    expect(calls).toHaveLength(0);
    expect(result.source).toBe('template');
    expect(result.problem).toBeNull();
    expect(result.models.map((model) => model.id)).toEqual([
      'sd_xl_base_1.0.safetensors',
      'flux1-dev.safetensors',
      'wan2.2_t2v_14B.safetensors',
    ]);
  });

  it('marks a curated list as template-sourced and fills the display name in', async () => {
    const result = await listModels(manifest('comfyui-local'), {
      fetch: failingFetch(new Error('never')),
    });
    expect(result.models[0]).toMatchObject({
      providerId: 'comfyui-local',
      source: 'template',
      displayName: 'SDXL Base 1.0',
    });
  });

  it('lists an endpoint catalogue and calls it synced', async () => {
    const { fetch, calls } = recorder(jsonResponse(200, { data: [{ id: 'gpt-4o' }] }));
    const result = await listModels(manifest('openai'), { fetch, credential: 'sk-1' });

    expect(calls[0]?.url).toBe('https://api.openai.com/v1/models');
    expect(calls[0]?.init.headers).toEqual({ Authorization: 'Bearer sk-1' });
    expect(result.source).toBe('synced');
    expect(result.problem).toBeNull();
    expect(result.models).toEqual([
      {
        id: 'gpt-4o',
        providerId: 'openai',
        displayName: 'GPT-4o',
        source: 'synced',
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        capabilities: { vision: true, tools: true, reasoning: false, embedding: false },
        inputPricePerMTok: 2.5,
        outputPricePerMTok: 10,
        deprecated: false,
      },
    ]);
  });

  it('gives an id the manifest has never seen nothing but its name', async () => {
    const { fetch } = recorder(jsonResponse(200, { data: [{ id: 'something-new' }] }));
    const result = await listModels(manifest('openai'), { fetch, credential: 'sk-1' });
    expect(result.models[0]).toMatchObject({
      id: 'something-new',
      displayName: 'something-new',
      capabilities: { vision: false, tools: false, reasoning: false, embedding: false },
      inputPricePerMTok: null,
      outputPricePerMTok: null,
    });
  });

  it('accepts an empty catalogue as an answer, not a failure', async () => {
    const { fetch } = recorder(jsonResponse(200, { data: [] }));
    const result = await listModels(manifest('openai'), { fetch, credential: 'sk-1' });
    expect(result.models).toEqual([]);
    expect(result.problem).toBeNull();
  });

  it('degrades an unreadable body to an empty list and a sentence', async () => {
    const { fetch } = recorder(jsonResponse(200, 'not json at all'));
    const result = await listModels(manifest('openai'), { fetch, credential: 'sk-1' });
    expect(result.models).toEqual([]);
    expect(result.problem).toBe('The endpoint answered, but its model list could not be read.');
  });

  it('names the class of a refusal rather than the status alone', async () => {
    const { fetch } = recorder(jsonResponse(401, { error: 'bad key' }));
    const result = await listModels(manifest('openai'), { fetch, credential: 'sk-bad' });
    expect(result.problem).toBe('The endpoint refused the request (auth, HTTP 401).');
  });

  it('reports a bare 429 as a rate limit', async () => {
    const { fetch } = recorder(jsonResponse(429, ''));
    const result = await listModels(manifest('openai'), { fetch, credential: 'sk-1' });
    expect(result.problem).toBe('The endpoint refused the request (rate_limit, HTTP 429).');
  });

  it('survives a fetch that rejects', async () => {
    const result = await listModels(manifest('openai'), {
      fetch: failingFetch(new Error('ECONNREFUSED')),
      credential: 'sk-1',
    });
    expect(result.models).toEqual([]);
    expect(result.problem).toBe('Could not reach the endpoint: ECONNREFUSED');
  });

  it('refuses to ask without a credential the provider requires', async () => {
    const { fetch, calls } = recorder(jsonResponse(200, { data: [] }));
    const result = await listModels(manifest('openai'), { fetch });
    expect(calls).toHaveLength(0);
    expect(result.problem).toBe(
      'This provider needs a credential before its models can be listed.',
    );
  });

  it('refuses to guess the placeholders a template still wants', async () => {
    const { fetch, calls } = recorder(jsonResponse(200, { models: [] }));
    const result = await listModels(manifest('google-vertex'), { fetch, credential: 'token' });
    expect(calls).toHaveLength(0);
    expect(result.problem).toBe('The endpoint needs region, project before it can be reached.');
  });

  it('reaches Vertex once the account supplies its values', async () => {
    const { fetch, calls } = recorder(
      jsonResponse(200, { models: [{ name: 'models/gemini-2.5-pro' }] }),
    );
    const result = await listModels(manifest('google-vertex'), {
      fetch,
      credential: 'token',
      values: { region: 'us-central1', project: 'p' },
    });
    expect(calls[0]?.url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models',
    );
    expect(result.models[0]).toMatchObject({ id: 'gemini-2.5-pro', source: 'synced' });
  });
});

describe('testConnection', () => {
  const clock = () => {
    let ticks = 1000;
    return () => {
      ticks += 25;
      return ticks;
    };
  };

  it('reports reachability, latency and the size of the listing', async () => {
    const { fetch } = recorder(jsonResponse(200, { data: [{ id: 'a' }, { id: 'b' }] }));
    const result = await testConnection(manifest('openai'), {
      fetch,
      credential: 'sk-1',
      now: clock(),
    });
    expect(result).toEqual({
      ok: true,
      latencyMs: 25,
      modelCount: 2,
      checkedAt: '1970-01-01T00:00:01.025Z',
      message: 'Reachable; listed 2 model(s).',
    });
  });

  it('probes a static provider at its base URL and claims no model count', async () => {
    const { fetch, calls } = recorder(jsonResponse(200, '<html>ComfyUI</html>'));
    const result = await testConnection(manifest('comfyui-local'), { fetch });
    expect(calls[0]?.url).toBe('http://127.0.0.1:8188');
    expect(result.ok).toBe(true);
    expect(result.modelCount).toBeNull();
    expect(result.message).toBe('The endpoint answered.');
  });

  it('fails with the class of a refusal', async () => {
    const { fetch } = recorder(jsonResponse(403, ''));
    const result = await testConnection(manifest('openai'), { fetch, credential: 'sk-bad' });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('The endpoint answered HTTP 403 (auth).');
  });

  it('fails without a latency when the endpoint cannot be reached', async () => {
    const result = await testConnection(manifest('openai'), {
      fetch: failingFetch(new Error('getaddrinfo ENOTFOUND')),
      credential: 'sk-1',
    });
    expect(result).toMatchObject({ ok: false, latencyMs: null, modelCount: null });
    expect(result.message).toContain('ENOTFOUND');
  });

  it('fails before asking when the credential is missing', async () => {
    const { fetch, calls } = recorder(jsonResponse(200, { data: [] }));
    const result = await testConnection(manifest('openai'), { fetch });
    expect(calls).toHaveLength(0);
    expect(result.message).toBe('Add a credential before testing this provider.');
  });
});
