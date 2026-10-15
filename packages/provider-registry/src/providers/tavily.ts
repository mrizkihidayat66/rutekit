import type { ProviderManifestInput } from '../manifest.ts';

/**
 * Search built for grounding, with an extract endpoint beside it. Like Exa
 * it has no model catalogue, so the empty list is a statement about what the
 * provider is rather than a gap in the manifest.
 */
export const tavily: ProviderManifestInput = {
  id: 'tavily',
  name: 'Tavily',
  description: 'Search API built for LLM grounding, with an extract endpoint.',
  category: 'search',
  icon: 'globe',
  docsUrl: 'https://docs.tavily.com',
  freeTier: true,

  endpoint: {
    baseUrl: 'https://api.tavily.com',
    wireFamily: 'custom',
    chatPath: null,
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

  models: [],

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
