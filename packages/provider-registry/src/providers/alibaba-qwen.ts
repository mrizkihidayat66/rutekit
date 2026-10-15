import type { ProviderManifestInput } from '../manifest.ts';

/**
 * Qwen through DashScope's OpenAI-compatible door. The international host is
 * the one the manifest names, so an account created outside the mainland
 * reaches the same catalogue.
 */
export const alibabaQwen: ProviderManifestInput = {
  id: 'alibaba-qwen',
  name: 'Alibaba Qwen',
  description: 'Qwen models via DashScope, with a generous free quota.',
  category: 'api-key',
  icon: 'cloud',
  docsUrl: 'https://help.aliyun.com/zh/dashscope',
  freeTier: true,

  endpoint: {
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
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
      id: 'qwen3-max',
      contextWindow: 262_000,
      maxOutputTokens: 32_000,
      capabilities: { tools: true, reasoning: true },
      inputPricePerMTok: 1.2,
      outputPricePerMTok: 6,
    },
    {
      id: 'qwen3-coder-plus',
      contextWindow: 1_000_000,
      maxOutputTokens: 65_000,
      capabilities: { tools: true },
      inputPricePerMTok: 1,
      outputPricePerMTok: 5,
    },
    {
      id: 'qwen-vl-max',
      contextWindow: 32_000,
      maxOutputTokens: 8000,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 0.8,
      outputPricePerMTok: 3.2,
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
