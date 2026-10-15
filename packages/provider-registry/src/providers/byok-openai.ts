import type { ProviderManifestInput } from '../manifest.ts';

/**
 * The escape hatch (FR-2.5): an OpenAI-compatible endpoint the operator points
 * rutekit at by hand. It is a template rather than a provider definition — the
 * address and the ids are placeholders, and the operator replaces both. There
 * is no docs URL because there is nothing public to link to, and no quota to
 * check because rutekit has no idea what sits behind the address.
 */
export const byokOpenai: ProviderManifestInput = {
  id: 'byok-openai',
  name: 'Custom OpenAI-compatible',
  description: 'A BYOK endpoint you pointed rutekit at by hand (FR-2.5).',
  category: 'byok',
  icon: 'plug',
  docsUrl: null,
  freeTier: false,

  endpoint: {
    baseUrl: 'https://gateway.internal.example/v1',
    wireFamily: 'openai',
    chatPath: '/chat/completions',
  },

  authModes: [{ mode: 'api-key', header: 'Authorization', scheme: 'Bearer' }],

  capabilities: {
    quota: false,
    oauth: false,
    automation: false,
    streaming: true,
    vision: true,
    tools: true,
  },

  discovery: { strategy: 'openai', path: '/models' },

  models: [
    {
      id: 'internal-gpt-4o',
      displayName: 'Internal GPT-4o',
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      capabilities: { vision: true, tools: true },
    },
    {
      id: 'internal-embedding',
      displayName: 'Internal Embedding',
      capabilities: { embedding: true },
    },
  ],

  quota: {
    kind: 'none',
    reason: 'A hand-configured endpoint reports no allowance rutekit knows how to read.',
  },

  errors: [
    { class: 'quota', statuses: [429], matches: ['insufficient_quota'] },
    { class: 'rate_limit', statuses: [429] },
    { class: 'auth', statuses: [401, 403] },
    { class: 'transient', statuses: [500, 502, 503, 504] },
  ],
};
