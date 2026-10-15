import type { ProviderManifestInput } from '../manifest.ts';

/**
 * Stable Diffusion generation, upscaling and editing behind one key. Like
 * the other media providers it has no chat path; unlike them it does have a
 * bearer token, so the auth mode is the ordinary one.
 */
export const stability: ProviderManifestInput = {
  id: 'stability',
  name: 'Stability AI',
  description: 'Stable Diffusion image generation, upscaling and editing.',
  category: 'media',
  icon: 'image',
  docsUrl: 'https://platform.stability.ai/docs',
  freeTier: false,

  endpoint: {
    baseUrl: 'https://api.stability.ai',
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
      id: 'sd3.5-large',
      maxOutputTokens: 8000,
      capabilities: { vision: true },
    },
    {
      id: 'sd3.5-large-turbo',
      maxOutputTokens: 8000,
      capabilities: { vision: true },
    },
    {
      id: 'stable-image-upscale',
      maxOutputTokens: 8000,
      capabilities: { vision: true },
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
