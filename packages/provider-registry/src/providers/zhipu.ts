import type { ProviderManifestInput } from '../manifest.ts';

/**
 * GLM models on a mainland endpoint. The small variant is genuinely free,
 * which is why one entry prices both directions at zero rather than
 * carrying null — null would read as "not priced", and this is priced at 0.
 */
export const zhipu: ProviderManifestInput = {
  id: 'zhipu',
  name: 'Zhipu AI',
  description: 'GLM models, including a free tier for the smaller variants.',
  category: 'api-key',
  icon: 'hexagon',
  docsUrl: 'https://docs.bigmodel.cn',
  freeTier: true,

  endpoint: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
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
      id: 'glm-4.6',
      contextWindow: 200_000,
      maxOutputTokens: 16_000,
      capabilities: { tools: true, reasoning: true },
      inputPricePerMTok: 0.6,
      outputPricePerMTok: 2.2,
    },
    {
      id: 'glm-4-flash',
      contextWindow: 128_000,
      maxOutputTokens: 8000,
      capabilities: { tools: true },
      inputPricePerMTok: 0,
      outputPricePerMTok: 0,
    },
    {
      id: 'glm-4v-plus',
      contextWindow: 16_000,
      maxOutputTokens: 4000,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 0.7,
      outputPricePerMTok: 0.7,
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
    startUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    captcha: true,
  },
};
