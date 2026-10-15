import type { ProviderManifestInput } from '../manifest.ts';

/**
 * Grok models over the OpenAI wire, with real-time search grounding. The
 * vision entry is a separate id rather than a flag on the text model, which
 * is why the catalogue lists both.
 */
export const xai: ProviderManifestInput = {
  id: 'xai',
  name: 'xAI',
  description: 'Grok models with real-time search grounding.',
  category: 'api-key',
  icon: 'x',
  docsUrl: 'https://docs.x.ai',
  freeTier: false,

  endpoint: {
    baseUrl: 'https://api.x.ai/v1',
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
      id: 'grok-4',
      contextWindow: 256_000,
      maxOutputTokens: 32_000,
      capabilities: { vision: true, tools: true, reasoning: true },
      inputPricePerMTok: 3,
      outputPricePerMTok: 15,
    },
    {
      id: 'grok-3-mini',
      contextWindow: 131_000,
      maxOutputTokens: 32_000,
      capabilities: { tools: true, reasoning: true },
      inputPricePerMTok: 0.3,
      outputPricePerMTok: 0.5,
    },
    {
      id: 'grok-2-vision-1212',
      contextWindow: 32_000,
      maxOutputTokens: 8000,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 2,
      outputPricePerMTok: 10,
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

  automation: { login: 'browser', startUrl: 'https://console.x.ai/', captcha: true },
};
