import type { ProviderManifestInput } from '../manifest.ts';

/**
 * Tencent's CodeBuddy coding agent, on the international tenant.
 *
 * A subscription endpoint an IDE signs into rather than a per-token API: the
 * models are mostly third-party weights (GLM, Kimi, MiniMax, DeepSeek, Hunyuan)
 * that the plan fronts, so an operator picks this provider on what the plan
 * costs and how much of it is left, not on which models it serves. Sign-in is a
 * browser flow, and the same tenant also accepts a pasted key — both are listed,
 * sign-in first, because the plan is what the provider is for.
 *
 * The authorize endpoints and the client id are the console's public defaults.
 * An instance issued its own registration overrides them with
 * `RUTEKIT_CODEBUDDY_INTL_OAUTH_CLIENT_ID` and the `_CLIENT_SECRET` beside it,
 * which is why neither is a secret here.
 */
export const codebuddyIntl: ProviderManifestInput = {
  id: 'codebuddy-intl',
  name: 'CodeBuddy',
  description: 'Tencent CodeBuddy coding agent; browser sign-in or a pasted key.',
  category: 'oauth',
  icon: 'bot',
  docsUrl: 'https://www.codebuddy.ai',
  freeTier: true,

  endpoint: {
    baseUrl: 'https://www.codebuddy.ai/v2',
    wireFamily: 'openai',
    chatPath: '/chat/completions',
  },

  authModes: [
    {
      mode: 'oauth-browser',
      clientId: 'codebuddy-console',
      authorizeUrl: 'https://www.codebuddy.ai/oauth/authorize',
      tokenUrl: 'https://www.codebuddy.ai/oauth/token',
      scopes: ['openid'],
      redirectPath: '/console/api/providers/codebuddy-intl/oauth/callback',
    },
    { mode: 'api-key', header: 'Authorization', scheme: 'Bearer' },
  ],

  capabilities: {
    quota: true,
    oauth: true,
    automation: true,
    streaming: true,
    vision: true,
    tools: true,
  },

  discovery: { strategy: 'openai', path: '/models' },

  models: [
    {
      id: 'glm-5.2',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'glm-5.1',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'glm-5.0',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'glm-5.0-turbo',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'glm-5v-turbo',
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      capabilities: { vision: true, tools: true },
    },
    {
      id: 'glm-4.7',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'minimax-m3',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'minimax-m2.7',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'kimi-k2.7',
      displayName: 'Kimi-K2.7-Code',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'kimi-k2.6',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'kimi-k2.5',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'hy3-preview',
      displayName: 'Hunyuan3 Preview',
      contextWindow: 128_000,
      maxOutputTokens: 32_000,
      capabilities: { tools: true },
    },
    {
      id: 'deepseek-v4-pro',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'deepseek-v4-flash',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'deepseek-v3-2-volc',
      displayName: 'DeepSeek V3.2 (Volcengine)',
      contextWindow: 128_000,
      maxOutputTokens: 32_000,
      capabilities: { tools: true },
    },
  ],

  // A plan, not a key: the allowance refills on a five-hour clock and the
  // numbers ride back on the response headers rather than on a status endpoint.
  quota: {
    kind: 'window',
    source: 'headers',
    windows: [{ windowSeconds: 18_000, label: '5-hour' }],
  },

  errors: [
    { class: 'quota', statuses: [429], matches: ['insufficient_quota'] },
    { class: 'rate_limit', statuses: [429] },
    { class: 'auth', statuses: [401, 403] },
    { class: 'transient', statuses: [500, 502, 503, 504] },
  ],

  automation: { login: 'browser', startUrl: 'https://www.codebuddy.ai/', captcha: true },
};
