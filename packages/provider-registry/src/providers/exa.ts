import type { ProviderManifestInput } from '../manifest.ts';

/**
 * A retrieval API rather than a model host: it takes a query and returns
 * pages. There is no model to list and none to route to, so the curated
 * list is empty on purpose — the provider exists for the tool surface, not
 * for chat traffic.
 */
export const exa: ProviderManifestInput = {
  id: 'exa',
  name: 'Exa',
  description: 'Neural search and page-content retrieval for agents.',
  category: 'search',
  icon: 'globe',
  docsUrl: 'https://docs.exa.ai',
  freeTier: true,

  endpoint: {
    baseUrl: 'https://api.exa.ai',
    wireFamily: 'custom',
    chatPath: null,
  },

  authModes: [{ mode: 'api-key', header: 'x-api-key' }],

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
