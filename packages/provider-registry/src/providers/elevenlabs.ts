import type { ProviderManifestInput } from '../manifest.ts';

/**
 * Speech synthesis and voice work. Its key rides in a header of its own
 * rather than in `Authorization`, and its catalogue is voice models — no
 * vision, and nothing that answers a chat request.
 */
export const elevenlabs: ProviderManifestInput = {
  id: 'elevenlabs',
  name: 'ElevenLabs',
  description: 'Speech synthesis, voice cloning and audio isolation.',
  category: 'media',
  icon: 'audio-lines',
  docsUrl: 'https://elevenlabs.io/docs',
  freeTier: true,

  endpoint: {
    baseUrl: 'https://api.elevenlabs.io/v1',
    wireFamily: 'custom',
    chatPath: null,
  },

  authModes: [{ mode: 'api-key', header: 'xi-api-key' }],

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
      id: 'eleven_multilingual_v2',
      maxOutputTokens: 8000,
    },
    {
      id: 'eleven_turbo_v2_5',
      maxOutputTokens: 8000,
    },
    {
      id: 'eleven_v3',
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
