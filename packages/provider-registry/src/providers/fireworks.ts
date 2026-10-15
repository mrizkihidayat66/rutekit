import type { ProviderManifestInput } from '../manifest.ts';

/**
 * Serving for open weights under an account-scoped path: every model id is
 * namespaced `accounts/fireworks/models/...`, which is the provider's own
 * convention rather than anything rutekit imposes.
 */
export const fireworks: ProviderManifestInput = {
  id: 'fireworks',
  name: 'Fireworks AI',
  description: 'Fast open-weight serving with function calling and JSON mode.',
  category: 'api-key',
  icon: 'flame',
  docsUrl: 'https://docs.fireworks.ai',
  freeTier: false,

  endpoint: {
    baseUrl: 'https://api.fireworks.ai/inference/v1',
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
      id: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      capabilities: { tools: true },
      inputPricePerMTok: 0.9,
      outputPricePerMTok: 0.9,
    },
    {
      id: 'accounts/fireworks/models/deepseek-v3',
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      capabilities: { tools: true },
      inputPricePerMTok: 0.9,
      outputPricePerMTok: 0.9,
    },
    {
      id: 'accounts/fireworks/models/qwen3-235b-a22b',
      contextWindow: 128_000,
      maxOutputTokens: 32_000,
      capabilities: { tools: true, reasoning: true },
      inputPricePerMTok: 0.22,
      outputPricePerMTok: 0.88,
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
    startUrl: 'https://fireworks.ai/account/api-keys',
    captcha: true,
  },
};
