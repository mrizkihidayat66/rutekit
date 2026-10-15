import type { ProviderManifestInput } from '../manifest.ts';

/**
 * The same coding endpoint reached from outside the mainland. A separate
 * provider rather than a region on the other one, because the host, the
 * account and the plan are all different.
 */
export const alicodeIntl: ProviderManifestInput = {
  id: 'alicode-intl',
  name: 'Alibaba Coding (intl)',
  description: 'The same coding endpoint, served from outside the mainland.',
  category: 'api-key',
  icon: 'cloud',
  docsUrl: 'https://bailian.console.aliyun.com',
  freeTier: false,

  endpoint: {
    baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
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
      id: 'qwen3.5-plus',
      displayName: 'Qwen3.5-Plus',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'qwen3-coder-next',
      displayName: 'Qwen3-Coder-Next',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'qwen3-coder-plus',
      displayName: 'Qwen3-Coder-Plus',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'kimi-k2.5',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'glm-5',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'glm-4.7',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'MiniMax-M2.5',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
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
