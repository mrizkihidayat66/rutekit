import type { ProviderManifestInput } from '../manifest.ts';

/**
 * The same escape hatch on the Messages wire, for the self-hosted proxy case
 * where the endpoint speaks Anthropic's shape rather than OpenAI's. The version
 * header is pinned here for the same reason it is pinned on the first-party
 * manifest: the wire changes shape between versions.
 */
export const byokAnthropic: ProviderManifestInput = {
  id: 'byok-anthropic',
  name: 'Custom Anthropic-compatible',
  description: 'A BYOK Messages endpoint, typically a self-hosted proxy.',
  category: 'byok',
  icon: 'plug',
  docsUrl: null,
  freeTier: false,

  endpoint: {
    baseUrl: 'https://claude.internal.example',
    wireFamily: 'anthropic',
    chatPath: '/messages',
    headers: { 'anthropic-version': '2023-06-01' },
  },

  authModes: [{ mode: 'api-key', header: 'x-api-key' }],

  capabilities: {
    quota: false,
    oauth: false,
    automation: false,
    streaming: true,
    vision: true,
    tools: true,
  },

  discovery: { strategy: 'anthropic', path: '/models' },

  models: [
    {
      id: 'internal-claude-sonnet',
      displayName: 'Internal Claude Sonnet',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
  ],

  quota: {
    kind: 'none',
    reason: 'A hand-configured endpoint reports no allowance rutekit knows how to read.',
  },

  errors: [
    { class: 'rate_limit', statuses: [429] },
    { class: 'auth', statuses: [401, 403] },
    { class: 'transient', statuses: [500, 502, 503, 504] },
  ],
};
