import type { ProviderManifestInput } from '../manifest.ts';

/**
 * Kimi models with very long context. The id is the versioned one the
 * provider serves, because Moonshot renames its stable alias on a schedule.
 */
export const moonshot: ProviderManifestInput = {
  id: 'moonshot',
  name: 'Moonshot AI',
  description: 'Kimi models with very long context and strong tool use.',
  category: 'api-key',
  icon: 'moon',
  docsUrl: 'https://platform.moonshot.ai/docs',
  freeTier: false,

  endpoint: {
    baseUrl: 'https://api.moonshot.ai/v1',
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
      id: 'kimi-k2-0905-preview',
      contextWindow: 256_000,
      maxOutputTokens: 16_000,
      capabilities: { tools: true },
      inputPricePerMTok: 0.6,
      outputPricePerMTok: 2.5,
    },
    {
      id: 'moonshot-v1-128k',
      contextWindow: 128_000,
      maxOutputTokens: 8000,
      capabilities: { tools: true },
      inputPricePerMTok: 2,
      outputPricePerMTok: 5,
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
    startUrl: 'https://platform.moonshot.ai/console/api-keys',
    captcha: true,
  },
};
