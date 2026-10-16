import type { ProviderManifestInput } from '../manifest.ts';

/**
 * AWS's Kiro, an agentic IDE whose plan is the credential.
 *
 * Sign-in is a device flow rather than a browser redirect — the endpoint lives
 * behind AWS SSO, and the operator approves the code from whatever browser they
 * already have. The plan's own line leads the catalogue and is served in four
 * flavours (plain, thinking, agentic, both), each a distinct id on the wire; the
 * rest are third-party weights the plan fronts.
 *
 * Its wire is its own, so `chatPath` is null and the curated list is what the
 * console shows. The client id is the console's public default; an instance with
 * its own registration overrides it with `RUTEKIT_KIRO_OAUTH_CLIENT_ID`.
 */
export const kiro: ProviderManifestInput = {
  id: 'kiro',
  name: 'Kiro AI',
  description: 'AWS agentic IDE; device-code sign-in, per-plan request quotas.',
  category: 'oauth',
  icon: 'brain-circuit',
  docsUrl: 'https://kiro.dev',
  freeTier: true,

  // Its own wire family, and now a codec to go with it: the request is JSON of a
  // shape nobody else uses and the response is AWS EventStream — length-prefixed
  // binary, not SSE — so it is a family rather than an option on one of the
  // three text dialects. `chatPath` stays null because the path carries the
  // account's `profileArn` as a query parameter, which only the codec knows.
  endpoint: {
    baseUrl: 'https://runtime.us-east-1.kiro.dev',
    wireFamily: 'kiro',
    chatPath: null,
  },

  authModes: [
    {
      mode: 'oauth-device',
      clientId: 'kiro-console',
      deviceCodeUrl: 'https://oidc.us-east-1.amazonaws.com/device_authorization',
      tokenUrl: 'https://oidc.us-east-1.amazonaws.com/token',
      scopes: ['sso:account:access'],
    },
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
      id: 'claude-sonnet-5',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'claude-sonnet-5-thinking',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'claude-sonnet-5-agentic',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'claude-sonnet-5-thinking-agentic',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'claude-sonnet-4.8',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'claude-sonnet-4.8-thinking',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'claude-sonnet-4.8-agentic',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'claude-sonnet-4.8-thinking-agentic',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'claude-sonnet-4.7',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'claude-sonnet-4.7-thinking',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'claude-sonnet-4.7-agentic',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'claude-sonnet-4.7-thinking-agentic',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'claude-sonnet-4.5',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'claude-sonnet-4.5-thinking',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'claude-sonnet-4.5-agentic',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'claude-sonnet-4.5-thinking-agentic',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'deepseek-3.2',
      displayName: 'DeepSeek V3.2',
      contextWindow: 128_000,
      maxOutputTokens: 32_000,
      capabilities: { tools: true },
    },
    {
      id: 'qwen3-coder-next',
      displayName: 'Qwen3-Coder-Next',
      contextWindow: 256_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'glm-5',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true, reasoning: true },
    },
    {
      id: 'minimax-m2.5',
      displayName: 'MiniMax-M2.5',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      capabilities: { tools: true },
    },
    {
      id: 'gpt-5.6-sol',
      contextWindow: 272_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'gpt-5.6-sol-thinking',
      contextWindow: 272_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'gpt-5.6-sol-agentic',
      contextWindow: 272_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'gpt-5.6-sol-thinking-agentic',
      contextWindow: 272_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'gpt-5.6-terra',
      contextWindow: 272_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'gpt-5.6-terra-thinking',
      contextWindow: 272_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'gpt-5.6-terra-agentic',
      contextWindow: 272_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'gpt-5.6-terra-thinking-agentic',
      contextWindow: 272_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'gpt-5.6-luna',
      contextWindow: 272_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'gpt-5.6-luna-thinking',
      contextWindow: 272_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'gpt-5.6-luna-agentic',
      contextWindow: 272_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
    },
    {
      id: 'gpt-5.6-luna-thinking-agentic',
      contextWindow: 272_000,
      maxOutputTokens: 64_000,
      capabilities: { vision: true, tools: true, reasoning: true },
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

  // Kiro's **authorization** endpoint, not its sign-in page.
  //
  // `kiro.dev/` is a landing page with no form; `app.kiro.dev/signin` is four
  // buttons and no input, and signing in there yields no credential at all — both
  // were tried against a live account. What kiro issues is an OAuth code, and it
  // issues one to this endpoint, which is why the automation starts here: the flow
  // appends its own PKCE challenge and reads the code out of the `kiro://` redirect
  // the browser cannot follow (see `flows/kiro-google.ts`).
  automation: {
    login: 'browser',
    startUrl: 'https://prod.us-east-1.auth.desktop.kiro.dev/login',
    captcha: true,
  },
};
