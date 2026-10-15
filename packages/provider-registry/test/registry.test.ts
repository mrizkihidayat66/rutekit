import { describe, expect, it } from 'vitest';

import {
  checkManifest,
  createProviderRegistry,
  type ManifestIssue,
  type ProviderManifestInput,
  providerManifestSchema,
  ProviderRegistryError,
} from '../src/index.ts';

/**
 * The registry is where a bad manifest stops being a data problem and becomes a
 * boot failure, so these tests are about the two halves of that: the lookups it
 * hands out, and the contradictions it refuses to be built over.
 */

const CAPS = {
  quota: true,
  oauth: false,
  automation: false,
  streaming: true,
  vision: true,
  tools: true,
};

/** A first-party API: one key, headers for quota, no sign-in, no automation. */
const OPENAI: ProviderManifestInput = {
  id: 'openai',
  name: 'OpenAI',
  description: 'First-party GPT and o-series models, with vision and tool calling.',
  category: 'api-key',
  icon: 'sparkles',
  docsUrl: 'https://platform.openai.com/docs',
  endpoint: { baseUrl: 'https://api.openai.com/v1', wireFamily: 'openai' },
  authModes: [{ mode: 'api-key', header: 'Authorization', scheme: 'Bearer' }],
  capabilities: CAPS,
  discovery: { strategy: 'openai' },
  models: [
    {
      id: 'gpt-4o',
      displayName: 'GPT-4o',
      contextWindow: 128_000,
      capabilities: { vision: true, tools: true },
    },
  ],
  quota: {
    kind: 'window',
    source: 'headers',
    windows: [{ windowSeconds: 3600, label: 'hourly' }],
  },
};

/** A coding agent that signs in through a browser *and* takes a pasted key. */
const CODEBUDDY: ProviderManifestInput = {
  id: 'codebuddy-intl',
  name: 'CodeBuddy',
  description: 'Tencent CodeBuddy coding agent; browser sign-in or a pasted key.',
  category: 'oauth',
  icon: 'bot',
  freeTier: true,
  endpoint: { baseUrl: 'https://www.codebuddy.ai/v2', wireFamily: 'openai' },
  authModes: [
    {
      mode: 'oauth-browser',
      clientId: 'codebuddy-console',
      authorizeUrl: 'https://www.codebuddy.ai/oauth/authorize',
      tokenUrl: 'https://www.codebuddy.ai/oauth/token',
      redirectPath: '/callback',
    },
    { mode: 'api-key', header: 'Authorization', scheme: 'Bearer' },
  ],
  capabilities: { ...CAPS, oauth: true },
  discovery: { strategy: 'openai' },
  quota: {
    kind: 'window',
    source: 'headers',
    windows: [{ windowSeconds: 18_000, label: '5-hour' }],
  },
};

/** A local runner: no credential, no quota, nothing to bill. */
const OLLAMA: ProviderManifestInput = {
  id: 'ollama-local',
  name: 'Ollama (local)',
  description: 'Local model runner with an OpenAI-compatible endpoint.',
  category: 'local',
  icon: 'hard-drive',
  freeTier: true,
  endpoint: { baseUrl: 'http://127.0.0.1:11434/v1', wireFamily: 'openai' },
  authModes: [{ mode: 'none' }],
  capabilities: { ...CAPS, quota: false },
  discovery: { strategy: 'static' },
  quota: { kind: 'none', reason: 'Local runner: the operator owns the hardware.' },
};

describe('the registry it hands out', () => {
  it('answers lookups in catalogue order', () => {
    const registry = createProviderRegistry([OPENAI, CODEBUDDY, OLLAMA]);

    expect(registry.size).toBe(3);
    expect(registry.ids()).toEqual(['openai', 'codebuddy-intl', 'ollama-local']);
    expect(registry.get('codebuddy-intl')?.name).toBe('CodeBuddy');
    expect(registry.has('ollama-local')).toBe(true);
  });

  it('reports a missing provider as absent rather than throwing', () => {
    const registry = createProviderRegistry([OPENAI]);

    expect(registry.get('nope')).toBeUndefined();
    expect(registry.has('nope')).toBe(false);
    expect(registry.byCategory('media')).toEqual([]);
  });

  it('groups by category without losing catalogue order', () => {
    const registry = createProviderRegistry([OPENAI, CODEBUDDY, OLLAMA]);

    expect(registry.byCategory('api-key').map((p) => p.id)).toEqual(['openai']);
    expect(registry.byCategory('oauth').map((p) => p.id)).toEqual(['codebuddy-intl']);
    expect(registry.byCategory('local').map((p) => p.id)).toEqual(['ollama-local']);
  });

  it('hands out arrays callers cannot mutate under it', () => {
    const registry = createProviderRegistry([OPENAI, CODEBUDDY]);

    expect(Object.isFrozen(registry.all())).toBe(true);
    expect(Object.isFrozen(registry.ids())).toBe(true);
    expect(Object.isFrozen(registry.byCategory('api-key'))).toBe(true);
  });

  it('accepts an empty catalogue', () => {
    expect(createProviderRegistry([]).size).toBe(0);
  });

  it('applies every default before handing a manifest out', () => {
    const registry = createProviderRegistry([OPENAI]);
    const manifest = registry.get('openai');

    expect(manifest?.endpoint.chatPath).toBeNull();
    expect(manifest?.endpoint.headers).toEqual({});
    expect(manifest?.freeTier).toBe(false);
    expect(manifest?.automation).toBeNull();
    expect(manifest?.errors).toEqual([]);
  });
});

/** Run the builder and hand back the error it was expected to raise. */
function registryError(inputs: readonly ProviderManifestInput[]): ProviderRegistryError {
  try {
    createProviderRegistry(inputs);
  } catch (error) {
    if (error instanceof ProviderRegistryError) return error;
    throw error;
  }
  throw new Error('expected createProviderRegistry to throw');
}

describe('what the registry refuses to be built over', () => {
  it('refuses two provider files claiming the same id', () => {
    const error = registryError([OPENAI, { ...OPENAI }]);

    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.field).toBe('id');
    expect(error.message).toContain('openai');
  });

  it('refuses a manifest the schema cannot read, and says where', () => {
    const error = registryError([
      { ...OPENAI, endpoint: { baseUrl: 'api.openai.com', wireFamily: 'openai' } },
    ]);

    expect(error.issues[0]?.providerId).toBe('openai');
    expect(error.issues[0]?.field).toBe('endpoint.baseUrl');
  });

  it('names the provider even when the id itself is unreadable', () => {
    const error = registryError([{ ...OPENAI, id: 42 } as unknown as ProviderManifestInput]);

    expect(error.issues[0]?.providerId).toBe('(unknown)');
    expect(error.issues[0]?.field).toBe('id');
  });

  it('reports every problem in one pass, not the first', () => {
    const error = registryError([
      { ...OPENAI, quota: { kind: 'none', reason: 'x' } },
      { ...OPENAI, id: 'other', capabilities: { ...CAPS, oauth: true } },
    ]);

    expect(error.issues.length).toBeGreaterThanOrEqual(2);
    expect(error.message).toMatch(/problems/);
  });

  it('carries the contradictions as data, not only as a message', () => {
    const error = registryError([{ ...OPENAI, capabilities: { ...CAPS, oauth: true } }]);

    expect(error).toBeInstanceOf(ProviderRegistryError);
    expect(error.name).toBe('ProviderRegistryError');
    expect(error.issues.map((issue) => issue.field)).toContain('capabilities.oauth');
  });
});

/** The cross-field problems in one patched manifest, as dotted field paths. */
function fieldsFor(patch: Record<string, unknown>): string[] {
  const manifest = providerManifestSchema.parse({ ...OPENAI, ...patch });
  return checkManifest(manifest).map((issue) => issue.field);
}

/** The same, for the tests that care about the wording rather than the path. */
function issuesFor(patch: Record<string, unknown>): readonly ManifestIssue[] {
  const manifest = providerManifestSchema.parse({ ...OPENAI, ...patch });
  return checkManifest(manifest);
}

describe('cross-field checks: the endpoint', () => {
  it('accepts the fixture it is given', () => {
    expect(fieldsFor({})).toEqual([]);
  });

  it('refuses an endpoint that is neither a URL nor a template', () => {
    expect(fieldsFor({ endpoint: { baseUrl: null, wireFamily: 'openai' } })).toEqual(['endpoint']);
  });

  it('refuses an endpoint that is somehow both', () => {
    expect(
      fieldsFor({
        endpoint: {
          baseUrl: 'https://api.openai.com/v1',
          baseUrlTemplate: 'https://{region}.openai.com/v1',
          wireFamily: 'openai',
        },
      }),
    ).toEqual(['endpoint']);
  });

  it('refuses a template with nothing in it for an account to resolve', () => {
    expect(
      fieldsFor({
        endpoint: {
          baseUrl: null,
          baseUrlTemplate: 'https://api.openai.com/v1',
          wireFamily: 'openai',
        },
      }),
    ).toEqual(['endpoint.baseUrlTemplate']);
  });

  it('refuses a default region the provider does not offer', () => {
    expect(
      fieldsFor({
        endpoint: {
          baseUrl: null,
          baseUrlTemplate: 'https://{region}.example.com/v1',
          wireFamily: 'openai',
          regions: { values: ['us-east1', 'eu-west1'], default: 'ap-south1', placement: 'host' },
        },
      }),
    ).toEqual(['endpoint.regions.default']);
  });

  it('refuses a param on a region that already sits in the host', () => {
    expect(
      fieldsFor({
        endpoint: {
          baseUrl: null,
          baseUrlTemplate: 'https://{region}.example.com/v1',
          wireFamily: 'openai',
          regions: {
            values: ['us-east1'],
            default: 'us-east1',
            placement: 'host',
            param: 'location',
          },
        },
      }),
    ).toEqual(['endpoint.regions.param']);
  });

  it('refuses a host region with no template to place it in', () => {
    expect(
      fieldsFor({
        endpoint: {
          baseUrl: 'https://api.openai.com/v1',
          wireFamily: 'openai',
          regions: { values: ['us-east1'], default: 'us-east1', placement: 'host' },
        },
      }),
    ).toEqual(['endpoint.regions']);
  });

  it('refuses a query region with no param to travel in', () => {
    expect(
      fieldsFor({
        endpoint: {
          baseUrl: 'https://api.openai.com/v1',
          wireFamily: 'openai',
          regions: { values: ['us-east1'], default: 'us-east1', placement: 'query' },
        },
      }),
    ).toEqual(['endpoint.regions.param']);
  });
});

describe('cross-field checks: auth and capability', () => {
  it('refuses the same auth mode listed twice', () => {
    expect(
      fieldsFor({
        authModes: [
          { mode: 'api-key', header: 'Authorization', scheme: 'Bearer' },
          { mode: 'api-key', header: 'X-Api-Key' },
        ],
      }),
    ).toEqual(['authModes']);
  });

  it('refuses an oauth capability with nothing to sign in with', () => {
    expect(fieldsFor({ capabilities: { ...CAPS, oauth: true } })).toEqual(['capabilities.oauth']);
  });

  it('refuses a sign-in the capability block does not admit to', () => {
    expect(
      fieldsFor({
        authModes: [
          { mode: 'api-key', header: 'Authorization', scheme: 'Bearer' },
          {
            mode: 'oauth-browser',
            clientId: 'rutekit',
            authorizeUrl: 'https://example.com/authorize',
            tokenUrl: 'https://example.com/token',
            redirectPath: '/callback',
          },
        ],
      }),
    ).toEqual(['capabilities.oauth']);
  });

  it('counts a service account as a sign-in', () => {
    expect(
      fieldsFor({
        authModes: [
          {
            mode: 'service-account',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          },
        ],
        capabilities: { ...CAPS, oauth: true },
      }),
    ).toEqual([]);
  });

  it('refuses a `free` provider that asks for a credential', () => {
    expect(fieldsFor({ category: 'free' })).toEqual(['category']);
  });

  it('refuses an `oauth` provider with no sign-in capability', () => {
    expect(fieldsFor({ category: 'oauth' })).toEqual(['category']);
  });
});

describe('cross-field checks: quota and automation', () => {
  it('refuses a quota capability over a policy of `none`', () => {
    expect(fieldsFor({ quota: { kind: 'none', reason: 'Not billed.' } })).toEqual([
      'capabilities.quota',
    ]);
  });

  it('refuses a quota policy the capability block denies', () => {
    expect(fieldsFor({ capabilities: { ...CAPS, quota: false } })).toEqual(['capabilities.quota']);
  });

  it('refuses an endpoint quota with no path to read it from', () => {
    expect(fieldsFor({ quota: { kind: 'credit', source: 'endpoint' } })).toEqual(['quota.path']);
  });

  it('refuses a path on a quota that comes from headers', () => {
    expect(
      fieldsFor({
        quota: {
          kind: 'window',
          source: 'headers',
          path: '/usage',
          windows: [{ windowSeconds: 3600, label: 'hourly' }],
        },
      }),
    ).toEqual(['quota.path']);
  });

  it('refuses an automation capability with no flow behind it', () => {
    expect(fieldsFor({ capabilities: { ...CAPS, automation: true } })).toEqual([
      'capabilities.automation',
    ]);
  });

  it('refuses a flow the capability block denies', () => {
    expect(
      fieldsFor({
        automation: { login: 'browser', startUrl: 'https://platform.openai.com/signup' },
      }),
    ).toEqual(['capabilities.automation']);
  });

  it('accepts a flow the capability block admits to', () => {
    expect(
      fieldsFor({
        capabilities: { ...CAPS, automation: true },
        automation: { login: 'browser', startUrl: 'https://platform.openai.com/signup' },
      }),
    ).toEqual([]);
  });

  it('says why an automation capability without a flow is refused', () => {
    const [issue] = issuesFor({ capabilities: { ...CAPS, automation: true } });

    expect(issue?.message).toContain('no automation flow is declared');
  });
});

describe('cross-field checks: the model list', () => {
  it('refuses the same model id listed twice', () => {
    expect(
      fieldsFor({
        models: [
          { id: 'gpt-4o', capabilities: { vision: true } },
          { id: 'gpt-4o', displayName: 'GPT-4o (again)' },
        ],
      }),
    ).toEqual(['models']);
  });

  it('accepts two models that differ', () => {
    expect(
      fieldsFor({
        models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini', upstreamId: 'gpt-4o-mini-2024-07-18' }],
      }),
    ).toEqual([]);
  });
});
