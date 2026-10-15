import type { ProviderManifestInput } from '../manifest.ts';

/**
 * An aggregator: the same wire as the reference manifest, but the model list is
 * the point rather than a detail. OpenRouter serves far more ids than rutekit
 * curates, so discovery runs with `passthrough` — an id the operator names that
 * is not in this list is forwarded rather than refused, which is the one place
 * that is the right default.
 *
 * Its quota is credit rather than a window: the account has a balance, and the
 * balance is readable from an endpoint rather than inferred from response
 * headers.
 */
export const openrouter: ProviderManifestInput = {
  id: 'openrouter',
  name: 'OpenRouter',
  description: 'Aggregator that fans one model id out across many upstreams.',
  category: 'aggregator',
  icon: 'route',
  docsUrl: 'https://openrouter.ai/docs',
  freeTier: true,

  endpoint: {
    baseUrl: 'https://openrouter.ai/api/v1',
    wireFamily: 'openai',
    chatPath: '/chat/completions',
  },

  authModes: [{ mode: 'api-key', header: 'Authorization', scheme: 'Bearer' }],

  capabilities: {
    quota: true,
    oauth: false,
    automation: false,
    streaming: true,
    vision: true,
    tools: true,
  },

  discovery: { strategy: 'openai', path: '/models', passthrough: true },

  models: [
    {
      id: 'openai/gpt-4o',
      displayName: 'GPT-4o',
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 2.5,
      outputPricePerMTok: 10,
    },
    {
      id: 'meta-llama/llama-3.3-70b-instruct',
      displayName: 'Llama 3.3 70B Instruct',
      contextWindow: 128_000,
      maxOutputTokens: 8192,
      capabilities: { tools: true },
      inputPricePerMTok: 0.12,
      outputPricePerMTok: 0.3,
    },
    {
      id: 'google/gemini-2.5-flash',
      displayName: 'Gemini 2.5 Flash',
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 0.3,
      outputPricePerMTok: 2.5,
    },
    {
      id: 'deepseek/deepseek-r1',
      displayName: 'DeepSeek R1',
      contextWindow: 128_000,
      maxOutputTokens: 32_768,
      capabilities: { reasoning: true },
      inputPricePerMTok: 0.55,
      outputPricePerMTok: 2.19,
    },
  ],

  quota: { kind: 'credit', source: 'endpoint', path: '/credits' },

  // 402 is OpenRouter's "out of credit", which is the same account-level stop as
  // the reference manifest's `insufficient_quota`, arriving a different way.
  errors: [
    { class: 'quota', statuses: [402] },
    { class: 'quota', statuses: [429], matches: ['insufficient_credits'] },
    { class: 'rate_limit', statuses: [429] },
    { class: 'auth', statuses: [401, 403] },
    { class: 'transient', statuses: [500, 502, 503, 504] },
  ],
};
