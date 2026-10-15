import type { ProviderManifestInput } from '../manifest.ts';

/**
 * CodeBuddy's mainland tenant, which is a second provider rather than a region
 * of the first.
 *
 * It serves a different endpoint, bills a different plan and carries a different
 * model set — the ids and the versions do not line up with the international
 * tenant's, and an account on one is not an account on the other. Folding them
 * into one manifest behind a `regions` list would have to pretend the two share
 * a model catalogue, which is exactly what the endpoint schema's region support
 * is not for.
 *
 * The console's public client id and authorize endpoints are the defaults; an
 * instance with its own registration overrides them with
 * `RUTEKIT_CODEBUDDY_CN_OAUTH_CLIENT_ID` and the `_CLIENT_SECRET` beside it.
 */
export const codebuddyCn: ProviderManifestInput = {
  id: 'codebuddy-cn',
  name: 'CodeBuddy CN',
  description: 'The mainland CodeBuddy tenant; a different plan and model set.',
  category: 'oauth',
  icon: 'bot',
  docsUrl: 'https://copilot.tencent.com',
  freeTier: true,

  endpoint: {
    baseUrl: 'https://copilot.tencent.com/v2',
    wireFamily: 'openai',
    chatPath: '/chat/completions',
  },

  authModes: [
    {
      mode: 'oauth-browser',
      clientId: 'codebuddy-cn-console',
      authorizeUrl: 'https://copilot.tencent.com/oauth/authorize',
      tokenUrl: 'https://copilot.tencent.com/oauth/token',
      scopes: ['openid'],
      redirectPath: '/console/api/providers/codebuddy-cn/oauth/callback',
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
      id: 'glm-5.3',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'glm-5.3-flash',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
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
      id: 'glm-5v-turbo',
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      capabilities: { vision: true, tools: true },
    },
    {
      id: 'minimax-m3',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'kimi-k3-1',
      displayName: 'Kimi-K3.1',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
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
      id: 'hy4-preview',
      displayName: 'Hunyuan4 Preview',
      contextWindow: 128_000,
      maxOutputTokens: 32_000,
      capabilities: { tools: true },
    },
    {
      id: 'hy3',
      displayName: 'Hunyuan3',
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
      id: 'deepseek-v4.1-flash',
      displayName: 'DeepSeek V4.1 Flash',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
  ],

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

  automation: { login: 'browser', startUrl: 'https://copilot.tencent.com/', captcha: true },
};
