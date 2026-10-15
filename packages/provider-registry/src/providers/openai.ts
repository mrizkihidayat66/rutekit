import type { ProviderManifestInput } from '../manifest.ts';

/**
 * The reference manifest: a first-party API with a fixed endpoint, one credential
 * shape, quota that arrives on the response, and a model list the provider itself
 * can enumerate.
 *
 * The other four providers in this batch differ from it in exactly one respect
 * each, which is why this one carries no surprises.
 */
export const openai: ProviderManifestInput = {
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
    chatPath: '/chat/completions',
  },

  authModes: [{ mode: 'api-key', header: 'Authorization', scheme: 'Bearer' }],

  capabilities: {
    quota: true,
    oauth: false,
    automation: true,
    streaming: true,
    vision: true,
    tools: true,
  },

  discovery: { strategy: 'openai', path: '/models' },

  models: [
    {
      id: 'gpt-4o',
      displayName: 'GPT-4o',
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 2.5,
      outputPricePerMTok: 10,
    },
    {
      id: 'gpt-4o-mini',
      displayName: 'GPT-4o mini',
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 0.15,
      outputPricePerMTok: 0.6,
    },
    {
      id: 'gpt-4.1',
      displayName: 'GPT-4.1',
      contextWindow: 1_047_576,
      maxOutputTokens: 32_768,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 2,
      outputPricePerMTok: 8,
    },
    {
      id: 'o3',
      displayName: 'o3',
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      capabilities: { vision: true, tools: true, reasoning: true },
      inputPricePerMTok: 2,
      outputPricePerMTok: 8,
    },
    {
      id: 'o4-mini',
      displayName: 'o4-mini',
      contextWindow: 200_000,
      maxOutputTokens: 100_000,
      capabilities: { vision: true, tools: true, reasoning: true },
      inputPricePerMTok: 1.1,
      outputPricePerMTok: 4.4,
    },
    {
      id: 'text-embedding-3-large',
      displayName: 'Embedding 3 Large',
      contextWindow: 8192,
      capabilities: { embedding: true },
      inputPricePerMTok: 0.13,
    },
    {
      id: 'gpt-3.5-turbo',
      displayName: 'GPT-3.5 Turbo',
      contextWindow: 16_385,
      maxOutputTokens: 4096,
      capabilities: { tools: true },
      inputPricePerMTok: 0.5,
      outputPricePerMTok: 1.5,
      deprecated: true,
    },
  ],

  quota: {
    kind: 'window',
    source: 'headers',
    windows: [
      { windowSeconds: 60, label: 'requests / minute' },
      { windowSeconds: 86_400, label: 'tokens / day' },
    ],
  },

  // Order is load-bearing: a bare 429 is a rate limit, but the same status with
  // `insufficient_quota` in the body means the account is out of credit, and the
  // account pool has to treat those two very differently.
  errors: [
    { class: 'quota', statuses: [429], matches: ['insufficient_quota'] },
    { class: 'rate_limit', statuses: [429] },
    { class: 'auth', statuses: [401, 403] },
    { class: 'transient', statuses: [500, 502, 503, 504] },
  ],

  automation: {
    login: 'browser',
    startUrl: 'https://platform.openai.com/api-keys',
    captcha: true,
  },
};
