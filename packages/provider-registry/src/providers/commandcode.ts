import type { ProviderManifestInput } from '../manifest.ts';

/**
 * One key in front of a rotating set of frontier coding models, mostly
 * third-party weights the operator never sees an account for. The ids carry
 * the upstream organisation as a path prefix, and the catalogue records them
 * as the endpoint serves them.
 */
export const commandcode: ProviderManifestInput = {
  id: 'commandcode',
  name: 'Command Code',
  description: 'Command Code API — frontier coding models behind a single key.',
  category: 'api-key',
  icon: 'bot',
  docsUrl: 'https://commandcode.ai',
  freeTier: false,

  endpoint: {
    baseUrl: 'https://api.commandcode.ai/alpha',
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
      id: 'deepseek/deepseek-v4-pro',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'deepseek/deepseek-v4-flash',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'moonshotai/Kimi-K2.6',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'moonshotai/Kimi-K2.5',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'zai-org/GLM-5.1',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'zai-org/GLM-5',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'MiniMaxAI/MiniMax-M2.7',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'MiniMaxAI/MiniMax-M2.5',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'Qwen/Qwen3.6-Max-Preview',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'Qwen/Qwen3.6-Plus',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'stepfun/Step-3.5-Flash',
      contextWindow: 128_000,
      maxOutputTokens: 32_000,
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

  automation: { login: 'browser', startUrl: 'https://commandcode.ai/', captcha: true },
};
