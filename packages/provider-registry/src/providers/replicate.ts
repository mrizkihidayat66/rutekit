import type { ProviderManifestInput } from '../manifest.ts';

/**
 * Community models run by version, across image, video, audio and text. The
 * wire is its own, and every entry is a hosted model rather than a local
 * one, which is why the flags say vision without saying chat.
 */
export const replicate: ProviderManifestInput = {
  id: 'replicate',
  name: 'Replicate',
  description: 'Run community models — image, video, audio and text — by version.',
  category: 'media',
  icon: 'boxes',
  docsUrl: 'https://replicate.com/docs',
  freeTier: false,

  endpoint: {
    baseUrl: 'https://api.replicate.com/v1',
    wireFamily: 'custom',
    chatPath: null,
  },

  authModes: [{ mode: 'api-key', header: 'Authorization', scheme: 'Bearer' }],

  capabilities: {
    quota: true,
    oauth: false,
    automation: false,
    streaming: false,
    vision: true,
    tools: false,
  },

  discovery: { strategy: 'static', requiresCredential: false },

  models: [
    {
      id: 'black-forest-labs/flux-1.1-pro',
      maxOutputTokens: 8000,
      capabilities: { vision: true },
    },
    {
      id: 'stability-ai/stable-video-diffusion',
      maxOutputTokens: 8000,
      capabilities: { vision: true },
    },
    {
      id: 'meta/musicgen',
      maxOutputTokens: 8000,
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
