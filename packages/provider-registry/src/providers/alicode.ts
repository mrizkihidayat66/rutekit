import type { ProviderManifestInput } from '../manifest.ts';

/**
 * Bailian's coding endpoint on the mainland: Qwen first-party, plus third-
 * party weights resold under the same key. Several entries carry an explicit
 * display name because the served id is a house abbreviation.
 */
export const alicode: ProviderManifestInput = {
  id: 'alicode',
  name: 'Alibaba Coding',
  description: 'Bailian coding endpoint on the mainland, carrying Qwen and third parties.',
  category: 'api-key',
  icon: 'cloud',
  docsUrl: 'https://bailian.console.aliyun.com',
  freeTier: false,

  endpoint: {
    baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
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
      id: 'qwen3-max-2026-01-23',
      displayName: 'Qwen3-Max',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
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
