import type { ProviderManifestInput } from '../manifest.ts';

/**
 * A prepaid Alibaba token plan served from Singapore, with its own model set
 * ahead of the general availability list — which is why the ids here are
 * versions the other two Alibaba endpoints do not carry yet.
 */
export const alitpIntl: ProviderManifestInput = {
  id: 'alitp-intl',
  name: 'Alibaba Token Plan',
  description: 'Prepaid Alibaba token plan served from the Singapore region.',
  category: 'api-key',
  icon: 'cloud',
  docsUrl: 'https://bailian.console.aliyun.com',
  freeTier: false,

  endpoint: {
    baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
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
      id: 'qwen3.8-max-preview',
      displayName: 'Qwen3.8-Max Preview',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'qwen3.7-max',
      displayName: 'Qwen3.7-Max',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'qwen3.7-plus',
      displayName: 'Qwen3.7-Plus',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'qwen3.6-flash',
      displayName: 'Qwen3.6-Flash',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'glm-5.2',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'deepseek-v4-pro',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
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

  automation: { login: 'browser', startUrl: 'https://bailian.console.aliyun.com/', captcha: true },
};
