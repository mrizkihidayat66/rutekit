import type { ProviderManifestInput } from '../manifest.ts';

/**
 * The same wire as the reference manifest, with the latency claim as the
 * product: an LPU host that answers faster than the model can be read. The
 * catalogue carries the ids Groq actually serves, not the upstream names.
 */
export const groq: ProviderManifestInput = {
  id: 'groq',
  name: 'Groq',
  description: 'LPU inference: the lowest time-to-first-token in the catalog.',
  category: 'api-key',
  icon: 'zap',
  docsUrl: 'https://console.groq.com/docs',
  freeTier: true,

  endpoint: {
    baseUrl: 'https://api.groq.com/openai/v1',
    wireFamily: 'openai',
    chatPath: '/chat/completions',
  },

  authModes: [{ mode: 'api-key', header: 'Authorization', scheme: 'Bearer' }],

  capabilities: {
    quota: true,
    oauth: false,
    automation: true,
    streaming: true,
    vision: true,
    tools: true,
  },

  discovery: { strategy: 'openai', path: '/models' },

  models: [
    {
      id: 'llama-3.3-70b-versatile',
      contextWindow: 128_000,
      maxOutputTokens: 32_000,
      capabilities: { tools: true },
      inputPricePerMTok: 0.59,
      outputPricePerMTok: 0.79,
    },
    {
      id: 'llama-3.1-8b-instant',
      contextWindow: 128_000,
      maxOutputTokens: 8000,
      capabilities: { tools: true },
      inputPricePerMTok: 0.05,
      outputPricePerMTok: 0.08,
    },
    {
      id: 'openai/gpt-oss-120b',
      contextWindow: 128_000,
      maxOutputTokens: 32_000,
      capabilities: { tools: true, reasoning: true },
      inputPricePerMTok: 0.15,
      outputPricePerMTok: 0.75,
    },
    {
      id: 'moonshotai/kimi-k2-instruct',
      contextWindow: 128_000,
      maxOutputTokens: 16_000,
      capabilities: { tools: true },
      inputPricePerMTok: 1,
      outputPricePerMTok: 3,
    },
  ],

  quota: {
    kind: 'window',
    source: 'headers',
    windows: [{ windowSeconds: 60, label: 'requests / minute' }],
  },

  errors: [
    { class: 'quota', statuses: [429], matches: ['insufficient_quota'] },
    { class: 'rate_limit', statuses: [429] },
    { class: 'auth', statuses: [401, 403] },
    { class: 'transient', statuses: [500, 502, 503, 504] },
  ],

  automation: { login: 'browser', startUrl: 'https://console.groq.com/keys', captcha: true },
};
