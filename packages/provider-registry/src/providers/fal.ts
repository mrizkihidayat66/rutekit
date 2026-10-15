import type { ProviderManifestInput } from '../manifest.ts';

/**
 * Low-latency diffusion endpoints. Everything here is a generation job with
 * a queue, so there is no chat path and no token price — the cost is per
 * run, which the manifest records as null rather than as zero.
 */
export const fal: ProviderManifestInput = {
  id: 'fal',
  name: 'fal.ai',
  description: 'Low-latency diffusion endpoints for images and short video.',
  category: 'media',
  icon: 'image',
  docsUrl: 'https://docs.fal.ai',
  freeTier: false,

  endpoint: {
    baseUrl: 'https://fal.run',
    wireFamily: 'custom',
    chatPath: null,
  },

  authModes: [{ mode: 'api-key', header: 'Authorization', scheme: 'Key' }],

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
      id: 'fal-ai/flux/dev',
      maxOutputTokens: 8000,
      capabilities: { vision: true },
    },
    {
      id: 'fal-ai/flux-pro/v1.1-ultra',
      maxOutputTokens: 8000,
      capabilities: { vision: true },
    },
    {
      id: 'fal-ai/kling-video/v2/master/text-to-video',
      maxOutputTokens: 8000,
      capabilities: { vision: true },
    },
    {
      id: 'fal-ai/whisper',
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
