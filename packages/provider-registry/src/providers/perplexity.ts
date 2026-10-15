import type { ProviderManifestInput } from '../manifest.ts';

/**
 * Search-grounded completion: the answer comes back with the citations that
 * produced it. The wire is OpenAI-shaped, but there is no catalogue endpoint,
 * so the curated list is the list.
 */
export const perplexity: ProviderManifestInput = {
  id: 'perplexity',
  name: 'Perplexity',
  description: 'Search-grounded completion models with inline citations.',
  category: 'search',
  icon: 'search',
  docsUrl: 'https://docs.perplexity.ai',
  freeTier: false,

  endpoint: {
    baseUrl: 'https://api.perplexity.ai',
    wireFamily: 'openai',
    chatPath: '/chat/completions',
  },

  authModes: [{ mode: 'api-key', header: 'Authorization', scheme: 'Bearer' }],

  capabilities: {
    quota: true,
    oauth: false,
    automation: false,
    streaming: false,
    vision: false,
    tools: false,
  },

  discovery: { strategy: 'static', requiresCredential: false },

  models: [
    {
      id: 'sonar-pro',
      contextWindow: 200_000,
      maxOutputTokens: 8000,
      inputPricePerMTok: 3,
      outputPricePerMTok: 15,
    },
    {
      id: 'sonar',
      contextWindow: 128_000,
      maxOutputTokens: 4000,
      inputPricePerMTok: 1,
      outputPricePerMTok: 1,
    },
    {
      id: 'sonar-reasoning-pro',
      contextWindow: 128_000,
      maxOutputTokens: 8000,
      capabilities: { reasoning: true },
      inputPricePerMTok: 2,
      outputPricePerMTok: 8,
    },
  ],

  quota: {
    kind: 'window',
    source: 'headers',
    windows: [{ windowSeconds: 60, label: 'requests / minute' }],
  },

  errors: [
    { class: 'rate_limit', statuses: [429] },
    { class: 'auth', statuses: [401, 403] },
    { class: 'transient', statuses: [500, 502, 503, 504] },
  ],
};
