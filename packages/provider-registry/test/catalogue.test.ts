import { describe, expect, it } from 'vitest';

import { createProviderRegistry } from '../src/registry.ts';
import { providerManifests } from '../src/providers/index.ts';

/**
 * The shipped catalogue, as opposed to the fixtures `registry.test.ts` builds.
 *
 * Everything here is a claim about the provider files in `src/providers/`, so it
 * fails the moment one of them contradicts the schema or the invariants — which is
 * the point of running the real list through the real constructor rather than
 * trusting that each file was reviewed on its own.
 */
const build = () => createProviderRegistry(providerManifests);

/** One provider, or a loud failure naming the one that is missing. */
const provider = (id: string) => {
  const manifest = build().get(id);
  if (manifest === undefined) throw new Error(`the catalogue has no provider '${id}'`);
  return manifest;
};

describe('the shipped catalogue', () => {
  it('builds without a contradiction', () => {
    expect(build).not.toThrow();
  });

  it('lists the whole catalogue, in catalogue order', () => {
    expect(build().ids()).toEqual([
      'alibaba-qwen',
      'alicode',
      'alicode-intl',
      'alitp-intl',
      'anthropic',
      'byok-anthropic',
      'byok-openai',
      'cerebras',
      'codebuddy-cn',
      'codebuddy-intl',
      'cohere',
      'comfyui-local',
      'commandcode',
      'deepinfra',
      'deepseek',
      'elevenlabs',
      'exa',
      'fal',
      'fireworks',
      'google-ai-studio',
      'google-vertex',
      'groq',
      'kiro',
      'lm-studio',
      'mistral',
      'moonshot',
      'ollama-local',
      'openai',
      'opencode',
      'openrouter',
      'perplexity',
      'qoder',
      'replicate',
      'sambanova',
      'stability',
      'tavily',
      'together',
      'xai',
      'zhipu',
    ]);
  });

  it('speaks all four wire families', () => {
    const families = new Set(
      build()
        .all()
        .map((manifest) => manifest.endpoint.wireFamily),
    );
    expect([...families].sort()).toEqual(['anthropic', 'custom', 'google', 'openai']);
  });

  it('gives every provider that serves a chat at least one curated model', () => {
    for (const manifest of build().all()) {
      if (manifest.endpoint.chatPath === null) continue;
      expect(
        manifest.models.length,
        `${manifest.id} serves a chat but lists no model`,
      ).toBeGreaterThan(0);
    }
  });

  it('gives the retrieval providers an empty list on purpose, not by omission', () => {
    for (const id of ['exa', 'tavily']) {
      const manifest = provider(id);
      expect(manifest.category).toBe('search');
      expect(manifest.endpoint.chatPath).toBeNull();
      expect(manifest.models).toEqual([]);
    }
  });

  it('gives every provider exactly one URL form', () => {
    for (const manifest of build().all()) {
      const { baseUrl, baseUrlTemplate } = manifest.endpoint;
      expect(baseUrl === null).not.toBe(baseUrlTemplate === null);
    }
  });

  it('assembles Vertex per account rather than writing a URL down', () => {
    const vertex = provider('google-vertex');
    expect(vertex.endpoint.baseUrl).toBeNull();
    expect(vertex.endpoint.baseUrlTemplate).toContain('{region}');
    expect(vertex.endpoint.regions?.placement).toBe('host');
  });

  it('files the local runner under local, with nothing to paste or check', () => {
    const local = provider('comfyui-local');
    expect(local.category).toBe('local');
    expect(local.authModes.map((auth) => auth.mode)).toEqual(['none']);
    expect(local.quota.kind).toBe('none');
    expect(local.capabilities.quota).toBe(false);
  });

  it('files the aggregator under aggregator, passing unknown ids through', () => {
    const aggregator = provider('openrouter');
    expect(aggregator.category).toBe('aggregator');
    expect(aggregator.discovery.passthrough).toBe(true);
  });

  it('backs every oauth-category provider with an actual oauth sign-in', () => {
    for (const id of ['codebuddy-intl', 'codebuddy-cn', 'kiro', 'qoder']) {
      const manifest = provider(id);
      expect(manifest.category, `${id} is not filed as oauth`).toBe('oauth');
      expect(manifest.capabilities.oauth, `${id} claims no oauth capability`).toBe(true);
      const modes = manifest.authModes.map((auth) => auth.mode);
      expect(
        modes.some((mode) => mode === 'oauth-browser' || mode === 'oauth-device'),
        `${id} lists no oauth auth mode`,
      ).toBe(true);
    }
  });
});
