import type { ProviderManifestInput } from '../manifest.ts';

/**
 * The one provider whose endpoint cannot be written down.
 *
 * Vertex has no single base URL: the host carries the region and the path carries
 * the project, and both are per-account. That is what `baseUrlTemplate` and
 * `regions` exist for — the region is chosen per account, it lands in the host
 * rather than in a parameter, and the schema plus the registry's construction
 * check keep a manifest from putting it somewhere Vertex would reject.
 *
 * The credential is a private key rather than something refreshed from a stored
 * secret, which is why the mode is `service-account` and not `oauth-browser`. The
 * registry still counts it as a sign-in for the `oauth` capability, because the
 * account is established by an authorization the operator performs out of band.
 */
export const googleVertex: ProviderManifestInput = {
  id: 'google-vertex',
  name: 'Google Vertex AI',
  description: 'Gemini and partner models behind a service account.',
  category: 'oauth',
  icon: 'gem',
  docsUrl: 'https://cloud.google.com/vertex-ai/docs',
  freeTier: false,

  endpoint: {
    baseUrl: null,
    baseUrlTemplate:
      'https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}',
    wireFamily: 'google',
    chatPath: null,
    regions: {
      values: ['us-central1', 'us-east5', 'europe-west4', 'asia-southeast1'],
      default: 'us-central1',
      // In the host, not a parameter: `us-central1-aiplatform.googleapis.com`
      // and `us-east5-aiplatform.googleapis.com` are different upstreams, and a
      // region sent as `?location=` is ignored rather than honoured.
      placement: 'host',
      param: null,
    },
  },

  authModes: [
    {
      mode: 'service-account',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    },
  ],

  capabilities: {
    quota: true,
    oauth: true,
    automation: false,
    streaming: true,
    vision: true,
    tools: true,
  },

  discovery: { strategy: 'google', path: '/publishers/google/models' },

  models: [
    {
      id: 'gemini-2.5-pro',
      displayName: 'Gemini 2.5 Pro',
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      capabilities: { vision: true, tools: true, reasoning: true },
      inputPricePerMTok: 1.25,
      outputPricePerMTok: 10,
    },
    {
      id: 'gemini-2.5-flash',
      displayName: 'Gemini 2.5 Flash',
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 0.3,
      outputPricePerMTok: 2.5,
    },
    {
      // A partner model served over the same endpoint: this is the entry that
      // makes `upstreamId` and the per-model wire override worth having, because
      // the id Vertex wants is not the id Anthropic's own API wants.
      id: 'claude-3-5-sonnet-v2@anthropic-ai',
      displayName: 'Claude 3.5 Sonnet v2 (Vertex)',
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      capabilities: { vision: true, tools: true },
      inputPricePerMTok: 3,
      outputPricePerMTok: 15,
    },
  ],

  // Vertex enforces per-project, per-model allowances that the response does not
  // report, so there is no window to name and no header to read. The row still
  // exists because the capability is real; the sweep records what it observes.
  quota: { kind: 'window', source: 'headers', windows: [] },

  errors: [
    { class: 'quota', statuses: [429], matches: ['RESOURCE_EXHAUSTED'] },
    { class: 'rate_limit', statuses: [429] },
    { class: 'auth', statuses: [401, 403] },
    { class: 'transient', statuses: [500, 502, 503, 504] },
  ],
};
