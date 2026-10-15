import type { ProviderManifestInput } from '../manifest.ts';

/**
 * Same credential story as the reference manifest, different wire: the key rides
 * in `x-api-key` with no scheme, the version is pinned by a header rather than in
 * the path, and the model list comes back in Anthropic's own envelope instead of
 * the OpenAI one.
 */
export const anthropic: ProviderManifestInput = {
  id: 'anthropic',
  name: 'Anthropic',
  description: 'Claude models with long context, extended thinking and vision.',
  category: 'api-key',
  icon: 'brain',
  docsUrl: 'https://docs.anthropic.com',
  freeTier: false,

  endpoint: {
    baseUrl: 'https://api.anthropic.com/v1',
    wireFamily: 'anthropic',
    chatPath: '/messages',
    // Pinned rather than negotiated: the wire family changes shape between
    // versions, so the manifest names the one it was written against.
    headers: { 'anthropic-version': '2023-06-01' },
  },

  authModes: [{ mode: 'api-key', header: 'x-api-key' }],

  capabilities: {
    quota: true,
    oauth: false,
    automation: true,
    streaming: true,
    vision: true,
    tools: true,
  },

  discovery: { strategy: 'anthropic', path: '/models' },

  models: [
    {
      id: 'claude-3-opus-20240229',
      displayName: 'Claude 3 Opus',
      contextWindow: 200_000,
      maxOutputTokens: 4096,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 15,
      outputPricePerMTok: 75,
    },
    {
      id: 'claude-3-5-sonnet-20241022',
      displayName: 'Claude 3.5 Sonnet',
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 3,
      outputPricePerMTok: 15,
    },
    {
      id: 'claude-3-5-haiku-20241022',
      displayName: 'Claude 3.5 Haiku',
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 0.8,
      outputPricePerMTok: 4,
    },
    {
      id: 'claude-3-sonnet-20240229',
      displayName: 'Claude 3 Sonnet',
      contextWindow: 200_000,
      maxOutputTokens: 4096,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 3,
      outputPricePerMTok: 15,
    },
    {
      id: 'claude-3-haiku-20240307',
      displayName: 'Claude 3 Haiku',
      contextWindow: 200_000,
      maxOutputTokens: 4096,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 0.25,
      outputPricePerMTok: 1.25,
      deprecated: true,
    },
  ],

  quota: {
    kind: 'window',
    source: 'headers',
    windows: [
      { windowSeconds: 60, label: 'requests / minute' },
      { windowSeconds: 60, label: 'tokens / minute' },
    ],
  },

  errors: [
    { class: 'rate_limit', statuses: [429] },
    { class: 'auth', statuses: [401, 403] },
    // Anthropic reports an over-loaded upstream as 529 rather than 503.
    { class: 'transient', statuses: [500, 502, 503, 504, 529] },
  ],

  automation: {
    login: 'browser',
    startUrl: 'https://console.anthropic.com/settings/keys',
    captcha: true,
  },
};
