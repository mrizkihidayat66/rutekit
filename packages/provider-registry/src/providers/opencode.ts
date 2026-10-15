import type { ProviderManifestInput } from '../manifest.ts';

/**
 * A public endpoint with no credential and no bill: the free channel of a
 * coding agent's own gateway. `none` is a real auth mode here, and the
 * quota block says why there is nothing to check rather than staying silent.
 */
export const opencode: ProviderManifestInput = {
  id: 'opencode',
  name: 'OpenCode Free',
  description: 'OpenCode Zen’s free channel — no key, no quota, no bill.',
  category: 'free',
  icon: 'terminal',
  docsUrl: 'https://opencode.ai/docs',
  freeTier: true,

  endpoint: {
    baseUrl: 'https://opencode.ai/zen/v1',
    wireFamily: 'openai',
    chatPath: '/chat/completions',
  },

  authModes: [{ mode: 'none' }],

  capabilities: {
    quota: false,
    oauth: false,
    automation: false,
    streaming: true,
    vision: true,
    tools: true,
  },

  discovery: { strategy: 'static', requiresCredential: false },

  models: [
    {
      id: 'muse-spark-1.2-contributor-free',
      displayName: 'Muse Spark 1.2 (contributor)',
      contextWindow: 128_000,
      maxOutputTokens: 32_000,
      capabilities: { tools: true },
    },
    {
      id: 'muse-spark-1.3-contributor-free',
      displayName: 'Muse Spark 1.3 (contributor)',
      contextWindow: 128_000,
      maxOutputTokens: 32_000,
      capabilities: { tools: true },
    },
  ],

  quota: { kind: 'none', reason: 'A public endpoint with no account and no allowance to check.' },

  errors: [
    { class: 'rate_limit', statuses: [429] },
    { class: 'auth', statuses: [401, 403] },
    { class: 'transient', statuses: [500, 502, 503, 504] },
  ],
};
