import type { ProviderManifestInput } from '../manifest.ts';

/**
 * Alibaba's Qoder coding agent.
 *
 * Its ids are opaque plan tiers — `ultimate`, `auto`, `performance` — that the
 * plan maps onto whatever model it is serving this month, alongside a handful of
 * directly named third-party ones. Both kinds are kept as the endpoint spells
 * them: an alias would hide the tier behind a model name the plan can change
 * without telling anyone.
 *
 * Its wire is its own, so `chatPath` is null. Sign-in is a browser flow, and the
 * same tenant accepts a pasted key. The client id is the console's public
 * default; an instance with its own registration overrides it with
 * `RUTEKIT_QODER_OAUTH_CLIENT_ID` and the `_CLIENT_SECRET` beside it.
 */
export const qoder: ProviderManifestInput = {
  id: 'qoder',
  name: 'Qoder',
  description: 'Alibaba Qoder coding agent; OAuth sign-in or a pasted key.',
  category: 'oauth',
  icon: 'droplet',
  docsUrl: 'https://qoder.com',
  freeTier: true,

  // Its own wire family, with a codec to match: the request is signed with a
  // session key and the response is [OI] chunks inside an envelope of qoder's
  // own. `chatPath` stays null because the path is part of the signature, so only
  // the codec can produce it.
  endpoint: {
    baseUrl: 'https://api3.qoder.sh',
    wireFamily: 'qoder',
    chatPath: null,
  },

  authModes: [
    {
      mode: 'oauth-browser',
      clientId: 'qoder-console',
      authorizeUrl: 'https://qoder.com/oauth/authorize',
      tokenUrl: 'https://api3.qoder.sh/oauth/token',
      scopes: ['openid'],
      redirectPath: '/console/api/providers/qoder/oauth/callback',
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

  discovery: { strategy: 'static', requiresCredential: false },

  models: [
    {
      id: 'ultimate',
      displayName: 'Qoder Ultimate',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'auto',
      displayName: 'Qoder Auto',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'performance',
      displayName: 'Qoder Performance',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'efficient',
      displayName: 'Qoder Efficient',
      contextWindow: 128_000,
      maxOutputTokens: 32_000,
      capabilities: { tools: true },
    },
    {
      id: 'lite',
      displayName: 'Qoder Lite',
      contextWindow: 128_000,
      maxOutputTokens: 32_000,
      capabilities: { tools: true },
    },
    {
      id: 'qmodel_38max',
      displayName: 'Qwen3.8-Max',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'qmodel_latest',
      displayName: 'Qwen3.7-Max',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'qmodel',
      displayName: 'Qwen3.7-Plus',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'qfmodel',
      displayName: 'Qwen3.8-Flash',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'kmodel_latest',
      displayName: 'Kimi-K3',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'kmodel',
      displayName: 'Kimi-K2.7-Code',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'gmodel',
      displayName: 'GLM-5.3',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'gfmodel',
      displayName: 'GLM-5.3-Flash',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'dmodel',
      displayName: 'DeepSeek-V4-Pro',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'dfmodel',
      displayName: 'DeepSeek-V4-Flash',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'mmodel',
      displayName: 'MiniMax-M3',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
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

  // Qoder's **sign-in page**, which is where a person starts.
  //
  // The flow presses the Google button on this page rather than being handed the
  // SSO endpoint's URL: the button is qoder's own, so the hand-off follows
  // wherever qoder points it and does not carry a callback and a client id this
  // manifest would have to keep in step. The email-and-password form on the same
  // page works and then ends at an Alibaba slider, which is why the button beside
  // it is the path taken (see `flows/qoder-google.ts`).
  automation: {
    login: 'browser',
    startUrl: 'https://qoder.com/users/sign-in',
    captcha: true,
  },
};
