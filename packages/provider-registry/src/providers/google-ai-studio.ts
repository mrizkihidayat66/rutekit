import type { ProviderManifestInput } from '../manifest.ts';

/**
 * The free-tier door into Gemini, and the one provider whose key is not a
 * bearer token: Google takes it in `x-goog-api-key`, and its model list comes
 * back in the `{models: [...]}` envelope with a `models/` prefix on every name.
 * The wire is the same one Vertex speaks, which is why both share `google`.
 */
export const googleAiStudio: ProviderManifestInput = {
  id: 'google-ai-studio',
  name: 'Google AI Studio',
  description: 'Gemini models on the free-tier API key path, vision and grounding.',
  category: 'api-key',
  icon: 'gem',
  docsUrl: 'https://ai.google.dev/docs',
  freeTier: true,

  endpoint: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    wireFamily: 'google',
    chatPath: null,
  },

  authModes: [{ mode: 'api-key', header: 'x-goog-api-key' }],

  capabilities: {
    quota: true,
    oauth: false,
    automation: true,
    streaming: true,
    vision: true,
    tools: true,
  },

  discovery: { strategy: 'google', path: '/models' },

  models: [
    {
      id: 'gemini-2.5-pro',
      contextWindow: 1_048_000,
      maxOutputTokens: 65_000,
      capabilities: { vision: true, tools: true, reasoning: true },
      inputPricePerMTok: 1.25,
      outputPricePerMTok: 10,
    },
    {
      id: 'gemini-2.5-flash',
      contextWindow: 1_048_000,
      maxOutputTokens: 65_000,
      capabilities: { vision: true, tools: true, reasoning: true },
      inputPricePerMTok: 0.3,
      outputPricePerMTok: 2.5,
    },
    {
      id: 'gemini-2.0-flash',
      contextWindow: 1_048_000,
      maxOutputTokens: 8000,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 0.1,
      outputPricePerMTok: 0.4,
    },
    {
      id: 'gemini-embedding-001',
      capabilities: { embedding: true },
      inputPricePerMTok: 0.15,
    },
  ],

  quota: {
    kind: 'window',
    source: 'headers',
    windows: [{ windowSeconds: 60, label: 'requests / minute' }],
  },

  errors: [
    { class: 'quota', statuses: [429], matches: ['RESOURCE_EXHAUSTED'] },
    { class: 'rate_limit', statuses: [429] },
    { class: 'auth', statuses: [401, 403] },
    { class: 'transient', statuses: [500, 502, 503, 504] },
  ],

  automation: { login: 'browser', startUrl: 'https://aistudio.google.com/apikey', captcha: true },
};
