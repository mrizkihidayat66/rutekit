import type { ProviderManifestInput } from '../manifest.ts';

/**
 * Wafer-scale inference: the selling point is tokens per second, so the
 * catalogue is short and picked for throughput rather than breadth.
 */
export const cerebras: ProviderManifestInput = {
  id: 'cerebras',
  name: 'Cerebras',
  description: 'Wafer-scale inference with unusually high tokens per second.',
  category: 'api-key',
  icon: 'cpu',
  docsUrl: 'https://inference-docs.cerebras.ai',
  freeTier: true,

  endpoint: {
    baseUrl: 'https://api.cerebras.ai/v1',
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
      id: 'llama-3.3-70b',
      contextWindow: 128_000,
      maxOutputTokens: 8000,
      capabilities: { tools: true },
      inputPricePerMTok: 0.85,
      outputPricePerMTok: 1.2,
    },
    {
      id: 'qwen-3-235b-a22b-instruct-2507',
      contextWindow: 64_000,
      maxOutputTokens: 16_000,
      capabilities: { tools: true },
      inputPricePerMTok: 0.6,
      outputPricePerMTok: 1.2,
    },
    {
      id: 'llama3.1-8b',
      contextWindow: 32_000,
      maxOutputTokens: 8000,
      capabilities: { tools: true },
      inputPricePerMTok: 0.1,
      outputPricePerMTok: 0.1,
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

  automation: { login: 'browser', startUrl: 'https://cloud.cerebras.ai/', captcha: true },
};
