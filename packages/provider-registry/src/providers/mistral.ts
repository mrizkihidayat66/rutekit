import type { ProviderManifestInput } from '../manifest.ts';

/**
 * A European lab serving both open-weight and commercial models over the
 * OpenAI wire, so nothing here needs a translator beyond the shared one.
 */
export const mistral: ProviderManifestInput = {
  id: 'mistral',
  name: 'Mistral AI',
  description: 'European open-weight and commercial models, fast and cheap.',
  category: 'api-key',
  icon: 'wind',
  docsUrl: 'https://docs.mistral.ai',
  freeTier: true,

  endpoint: {
    baseUrl: 'https://api.mistral.ai/v1',
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
      id: 'mistral-large-latest',
      contextWindow: 128_000,
      maxOutputTokens: 8000,
      capabilities: { tools: true },
      inputPricePerMTok: 2,
      outputPricePerMTok: 6,
    },
    {
      id: 'mistral-small-latest',
      contextWindow: 128_000,
      maxOutputTokens: 8000,
      capabilities: { tools: true },
      inputPricePerMTok: 0.2,
      outputPricePerMTok: 0.6,
    },
    {
      id: 'codestral-latest',
      contextWindow: 256_000,
      maxOutputTokens: 8000,
      capabilities: { tools: true },
      inputPricePerMTok: 0.3,
      outputPricePerMTok: 0.9,
    },
    {
      id: 'pixtral-large-latest',
      contextWindow: 128_000,
      maxOutputTokens: 8000,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 2,
      outputPricePerMTok: 6,
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

  automation: { login: 'browser', startUrl: 'https://console.mistral.ai/api-keys', captcha: true },
};
