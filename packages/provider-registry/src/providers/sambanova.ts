import type { ProviderManifestInput } from '../manifest.ts';

/**
 * RDU inference for large open weights. Its list mixes instruction models
 * with a reasoning model and a vision model, so the flags differ per entry
 * rather than being uniform across the provider.
 */
export const sambanova: ProviderManifestInput = {
  id: 'sambanova',
  name: 'SambaNova',
  description: 'RDU inference for large open-weight models at low latency.',
  category: 'api-key',
  icon: 'box',
  docsUrl: 'https://docs.sambanova.ai',
  freeTier: true,

  endpoint: {
    baseUrl: 'https://api.sambanova.ai/v1',
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
      id: 'Meta-Llama-3.3-70B-Instruct',
      contextWindow: 128_000,
      maxOutputTokens: 8000,
      capabilities: { tools: true },
      inputPricePerMTok: 0.6,
      outputPricePerMTok: 1.2,
    },
    {
      id: 'DeepSeek-R1',
      contextWindow: 32_000,
      maxOutputTokens: 8000,
      capabilities: { reasoning: true },
      inputPricePerMTok: 5,
      outputPricePerMTok: 7,
    },
    {
      id: 'Llama-4-Maverick-17B-128E-Instruct',
      contextWindow: 128_000,
      maxOutputTokens: 8000,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 0.63,
      outputPricePerMTok: 1.8,
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

  automation: { login: 'browser', startUrl: 'https://cloud.sambanova.ai/', captcha: true },
};
