import type { ProviderManifestInput } from '../manifest.ts';

/**
 * The same shape as the other local runner, from a desktop app rather than
 * a daemon. The curated list is two small instruction models, which is what
 * a default install actually has loaded.
 */
export const lmStudio: ProviderManifestInput = {
  id: 'lm-studio',
  name: 'LM Studio (local)',
  description: 'Desktop model server, exposed here as a local provider.',
  category: 'local',
  icon: 'monitor',
  docsUrl: 'https://lmstudio.ai/docs',
  freeTier: true,

  endpoint: {
    baseUrl: 'http://127.0.0.1:1234/v1',
    wireFamily: 'openai',
    chatPath: '/chat/completions',
  },

  authModes: [{ mode: 'none' }],

  capabilities: {
    quota: false,
    oauth: false,
    automation: false,
    streaming: true,
    vision: false,
    tools: true,
  },

  discovery: { strategy: 'openai', path: '/models', requiresCredential: false },

  models: [
    {
      id: 'qwen2.5-7b-instruct',
      contextWindow: 32_000,
      maxOutputTokens: 4000,
      capabilities: { tools: true },
    },
    {
      id: 'mistral-7b-instruct-v0.3',
      contextWindow: 32_000,
      maxOutputTokens: 4000,
    },
  ],

  quota: { kind: 'none', reason: 'A local runner has no account and no allowance to check.' },

  errors: [],
};
