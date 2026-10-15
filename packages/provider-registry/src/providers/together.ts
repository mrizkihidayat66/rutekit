import type { ProviderManifestInput } from '../manifest.ts';

/**
 * Hosted open weights with a per-model price list. Its image models sit in
 * the same catalogue as its chat models, which is why one entry carries no
 * context window at all — a diffusion model has no prompt-length limit.
 */
export const together: ProviderManifestInput = {
  id: 'together',
  name: 'Together AI',
  description: 'Hosted open-weight models with a broad fine-tune catalogue.',
  category: 'api-key',
  icon: 'layers',
  docsUrl: 'https://docs.together.ai',
  freeTier: false,

  endpoint: {
    baseUrl: 'https://api.together.xyz/v1',
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
      id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      contextWindow: 128_000,
      maxOutputTokens: 8000,
      capabilities: { tools: true },
      inputPricePerMTok: 0.88,
      outputPricePerMTok: 0.88,
    },
    {
      id: 'Qwen/Qwen2.5-72B-Instruct-Turbo',
      contextWindow: 32_000,
      maxOutputTokens: 8000,
      capabilities: { tools: true },
      inputPricePerMTok: 1.2,
      outputPricePerMTok: 1.2,
    },
    {
      id: 'deepseek-ai/DeepSeek-R1',
      contextWindow: 128_000,
      maxOutputTokens: 32_000,
      capabilities: { reasoning: true },
      inputPricePerMTok: 3,
      outputPricePerMTok: 7,
    },
    {
      id: 'black-forest-labs/FLUX.1-schnell',
      maxOutputTokens: 8000,
      inputPricePerMTok: 0,
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
    startUrl: 'https://api.together.xyz/settings/api-keys',
    captcha: true,
  },
};
