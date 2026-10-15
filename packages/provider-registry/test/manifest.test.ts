import { describe, expect, it } from 'vitest';

import { providerManifestSchema } from '../src/index.ts';

/**
 * The schema is the reviewable core of the registry, so these tests are about
 * what it promises a manifest author: which fields are required, which fill
 * themselves in, and which combinations are refused outright.
 */

/** A complete, realistic manifest — the shape every provider file must match. */
const OPENAI = {
  id: 'openai',
  name: 'OpenAI',
  description: 'First-party GPT and o-series models, with vision and tool calling.',
  category: 'api-key',
  icon: 'sparkles',
  docsUrl: 'https://platform.openai.com/docs',
  freeTier: false,
  endpoint: {
    baseUrl: 'https://api.openai.com/v1',
    wireFamily: 'openai',
  },
  authModes: [{ mode: 'api-key', header: 'Authorization', scheme: 'Bearer' }],
  capabilities: {
    quota: true,
    oauth: false,
    automation: false,
    streaming: true,
    vision: true,
    tools: true,
  },
  discovery: { strategy: 'openai' },
  models: [
    {
      id: 'gpt-4o',
      displayName: 'GPT-4o',
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 2.5,
      outputPricePerMTok: 10,
    },
  ],
  quota: {
    kind: 'window',
    source: 'headers',
    windows: [{ windowSeconds: 3600, label: 'hourly' }],
  },
  errors: [{ class: 'rate_limit', statuses: [429] }],
  automation: null,
};

describe('provider manifest: the required shape', () => {
  it('parses a full manifest', () => {
    const parsed = providerManifestSchema.parse(OPENAI);
    expect(parsed.id).toBe('openai');
    expect(parsed.endpoint.wireFamily).toBe('openai');
    expect(parsed.authModes[0]?.mode).toBe('api-key');
    expect(parsed.models).toHaveLength(1);
  });

  it('fills in every optional field a manifest left out', () => {
    const parsed = providerManifestSchema.parse(OPENAI);

    // Endpoint: nothing stated beyond the URL and the dialect.
    expect(parsed.endpoint.baseUrlTemplate).toBeNull();
    expect(parsed.endpoint.chatPath).toBeNull();
    expect(parsed.endpoint.headers).toEqual({});
    expect(parsed.endpoint.queryParams).toEqual({});
    expect(parsed.endpoint.regions).toBeNull();

    // Discovery defaults to the cautious reading: ask, with a credential, and do
    // not forward ids we do not recognise.
    expect(parsed.discovery.path).toBeNull();
    expect(parsed.discovery.requiresCredential).toBe(true);
    expect(parsed.discovery.passthrough).toBe(false);

    // The quota window carries no endpoint because the numbers arrive on headers.
    expect(parsed.quota.kind).toBe('window');
    if (parsed.quota.kind === 'window') {
      expect(parsed.quota.path).toBeNull();
    }

    // An error rule is credential-scoped until it says otherwise.
    expect(parsed.errors[0]?.scope).toBe('credential');
    expect(parsed.errors[0]?.matches).toEqual([]);

    expect(parsed.automation).toBeNull();
    expect(parsed.freeTier).toBe(false);
  });

  it('completes a model entry from the few flags that were stated', () => {
    const parsed = providerManifestSchema.parse(OPENAI);
    const model = parsed.models[0];

    expect(model?.capabilities).toEqual({
      vision: true,
      tools: true,
      reasoning: false,
      embedding: false,
    });
    expect(model?.deprecated).toBe(false);
    expect(model?.upstreamId).toBeNull();
    expect(model?.wireFamily).toBeNull();
  });

  it('accepts a provider that states nothing optional at all', () => {
    const parsed = providerManifestSchema.parse({
      id: 'ollama-local',
      name: 'Ollama (local)',
      description: 'Local model runner.',
      category: 'local',
      icon: 'hard-drive',
      endpoint: { baseUrl: 'http://127.0.0.1:11434/v1', wireFamily: 'openai' },
      authModes: [{ mode: 'none' }],
      capabilities: {
        quota: false,
        oauth: false,
        automation: false,
        streaming: true,
        vision: false,
        tools: true,
      },
      discovery: { strategy: 'static' },
      quota: { kind: 'none', reason: 'Local runner: the operator owns the hardware.' },
    });

    expect(parsed.models).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.docsUrl).toBeNull();
  });
});

describe('provider manifest: what it refuses', () => {
  it('rejects a half-filled oauth block instead of reading it as an api key', () => {
    const result = providerManifestSchema.safeParse({
      ...OPENAI,
      authModes: [
        { mode: 'oauth-browser', clientId: 'rutekit', authorizeUrl: 'https://example.com/authorize' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a quota policy of `none` with no written reason', () => {
    const result = providerManifestSchema.safeParse({ ...OPENAI, quota: { kind: 'none' } });
    expect(result.success).toBe(false);
  });

  it('rejects an error rule that matches on nothing', () => {
    const result = providerManifestSchema.safeParse({
      ...OPENAI,
      errors: [{ class: 'transient' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown wire family', () => {
    const result = providerManifestSchema.safeParse({
      ...OPENAI,
      endpoint: { baseUrl: 'https://example.com/v1', wireFamily: 'grpc' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an endpoint that is neither a URL nor a template', () => {
    const result = providerManifestSchema.safeParse({
      ...OPENAI,
      endpoint: { baseUrl: 'api.openai.com', wireFamily: 'openai' },
    });
    expect(result.success).toBe(false);
  });
});
