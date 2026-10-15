import type { ProviderManifestInput } from '../manifest.ts';

/**
 * Two ids with two different jobs: a chat model with tool calling, and a
 * reasoner that spends its output budget on thinking before it answers.
 */
export const deepseek: ProviderManifestInput = {
  id: 'deepseek',
  name: 'DeepSeek',
  description: 'Reasoning and coding models at a fraction of frontier pricing.',
  category: 'api-key',
  icon: 'search',
  docsUrl: 'https://api-docs.deepseek.com',
  freeTier: false,

  endpoint: {
    baseUrl: 'https://api.deepseek.com/v1',
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
      id: 'deepseek-chat',
      contextWindow: 64_000,
      maxOutputTokens: 8000,
      capabilities: { tools: true },
      inputPricePerMTok: 0.27,
      outputPricePerMTok: 1.1,
    },
    {
      id: 'deepseek-reasoner',
      contextWindow: 64_000,
      maxOutputTokens: 64_000,
      capabilities: { reasoning: true },
      inputPricePerMTok: 0.55,
      outputPricePerMTok: 2.19,
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

  automation: {
    login: 'browser',
    startUrl: 'https://platform.deepseek.com/api_keys',
    captcha: true,
  },
};
