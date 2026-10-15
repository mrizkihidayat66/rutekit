import type { ProviderManifestInput } from '../manifest.ts';

/**
 * A plain per-token price list over the OpenAI wire, with the model ids the
 * upstream repositories publish rather than a house renaming.
 */
export const deepinfra: ProviderManifestInput = {
  id: 'deepinfra',
  name: 'DeepInfra',
  description: 'Pay-per-token open-weight inference with a simple price list.',
  category: 'api-key',
  icon: 'server',
  docsUrl: 'https://deepinfra.com/docs',
  freeTier: false,

  endpoint: {
    baseUrl: 'https://api.deepinfra.com/v1/openai',
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
      id: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
      contextWindow: 128_000,
      maxOutputTokens: 8000,
      capabilities: { tools: true },
      inputPricePerMTok: 0.35,
      outputPricePerMTok: 0.4,
    },
    {
      id: 'mistralai/Mixtral-8x7B-Instruct-v0.1',
      contextWindow: 32_000,
      maxOutputTokens: 8000,
      inputPricePerMTok: 0.24,
      outputPricePerMTok: 0.24,
    },
    {
      id: 'Qwen/Qwen2.5-Coder-32B-Instruct',
      contextWindow: 32_000,
      maxOutputTokens: 8000,
      capabilities: { tools: true },
      inputPricePerMTok: 0.07,
      outputPricePerMTok: 0.16,
    },
  ],

  quota: {
    kind: 'window',
    source: 'headers',
    windows: [{ windowSeconds: 60, label: 'requests / minute' }],
  },

  errors: [
    { class: 'quota', statuses: [429], matches: ['insufficient_quota'] },
    { class: 'rate_limit', statuses: [429] },
    { class: 'auth', statuses: [401, 403] },
    { class: 'transient', statuses: [500, 502, 503, 504] },
  ],

  automation: { login: 'browser', startUrl: 'https://deepinfra.com/dash/api_keys', captcha: true },
};
