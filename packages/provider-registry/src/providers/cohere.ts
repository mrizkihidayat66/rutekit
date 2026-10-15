import type { ProviderManifestInput } from '../manifest.ts';

/**
 * The first provider whose wire rutekit does not speak natively: Command
 * models use their own request shape, so `custom` is the honest answer and
 * the translator is a later group's problem. Its `/models` endpoint answers
 * in a shape no listing strategy recognises, so the curated list is the list.
 * No vision: Command models take text and documents, not images.
 */
export const cohere: ProviderManifestInput = {
  id: 'cohere',
  name: 'Cohere',
  description: 'Command models tuned for RAG, plus a first-class reranker.',
  category: 'api-key',
  icon: 'compass',
  docsUrl: 'https://docs.cohere.com',
  freeTier: true,

  endpoint: {
    baseUrl: 'https://api.cohere.com/v2',
    wireFamily: 'custom',
    chatPath: null,
  },

  authModes: [{ mode: 'api-key', header: 'Authorization', scheme: 'Bearer' }],

  capabilities: {
    quota: true,
    oauth: false,
    automation: true,
    streaming: true,
    vision: false,
    tools: true,
  },

  discovery: { strategy: 'static', requiresCredential: false },

  models: [
    {
      id: 'command-a-03-2025',
      contextWindow: 256_000,
      maxOutputTokens: 8000,
      capabilities: { tools: true },
      inputPricePerMTok: 2.5,
      outputPricePerMTok: 10,
    },
    {
      id: 'command-r-plus-08-2024',
      contextWindow: 128_000,
      maxOutputTokens: 4000,
      capabilities: { tools: true },
      inputPricePerMTok: 2.5,
      outputPricePerMTok: 10,
    },
    {
      id: 'embed-v4.0',
      capabilities: { embedding: true },
      inputPricePerMTok: 0.12,
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

  automation: {
    login: 'browser',
    startUrl: 'https://dashboard.cohere.com/api-keys',
    captcha: true,
  },
};
