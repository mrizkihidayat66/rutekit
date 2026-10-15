/**
 * The control-plane URL namespace.
 *
 * rutekit serves two namespaces to two audiences (ADR-0003):
 *
 *   - `/v1/*`          the five OpenAI-compatible data-plane surfaces, spoken by
 *                      whatever client SDK the operator already has;
 *   - `/console/api/*` the control plane the dashboard reads and writes.
 *
 * They are kept apart on purpose. A `/v1` client must never be able to reach a
 * route that edits the pool, and the dashboard must never have to understand a
 * completion payload. The split is what lets the two planes be secured, versioned
 * and rate-limited independently — a property neither plane can have if they
 * share a namespace.
 *
 * Paths here are *templates*: `:name` marks a parameter. `consolePath` fills
 * them, and the same string doubles as an MSW route pattern.
 */
export const CONSOLE_API_PREFIX = '/console/api' as const;

/**
 * Fill a path template. A missing parameter throws rather than emitting a
 * literal `:id`, so a broken call site fails at the boundary instead of
 * requesting a path no handler matches.
 */
export function consolePath(
  template: string,
  params: Readonly<Record<string, string>> = {},
): string {
  const path = template.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`consolePath: missing parameter "${key}" for "${template}"`);
    }
    return encodeURIComponent(value);
  });
  return `${CONSOLE_API_PREFIX}${path}`;
}

/**
 * Every control-plane route, without the `/console/api` prefix so the string
 * reads as a template and can be handed straight to `consolePath` or to MSW.
 *
 * Grouped by the nav section that owns the page — the same grouping the page
 * files use, so a reader can walk from a screen to its routes in one hop.
 */
export const consolePaths = {
  // Overview — Dashboard, Usage & Metrics, Console Log
  dashboard: '/dashboard',
  lowStress: '/dashboard/low-stress',
  usageSummary: '/usage/summary',
  usageSeries: '/usage/series',
  usageBreakdown: '/usage/breakdown',
  requests: '/requests',
  request: '/requests/:id',
  logs: '/logs',

  // Providers — Provider Catalog, Provider Detail, Accounts, Quota Management
  providers: '/providers',
  provider: '/providers/:id',
  providerTest: '/providers/:id/test',
  providerModels: '/providers/:id/models',
  providerModel: '/providers/:id/models/:modelId',
  providerModelsFetch: '/providers/:id/models/fetch',
  providerOauth: '/providers/:id/oauth',
  /**
   * Where the provider sends the browser back (C3b2). A GET, because it is a
   * redirect and not an API call: the provider has the code in the query string
   * and nothing else to say. It lives under the console prefix so it is guarded
   * by the same session cookie the operator already holds, which is also what
   * makes the flow single-operator rather than open to anyone who guesses a
   * state.
   */
  providerOauthCallback: '/providers/:id/oauth/callback',
  /** Every model from every provider, for the catalog page. */
  models: '/models',
  accounts: '/accounts',
  account: '/accounts/:id',
  accountsBulk: '/accounts/bulk',
  quota: '/quota',
  quotaCheck: '/quota/check',

  // Routing — Combos & Routes, Model Mapping, Filter Rules, Token Saver, API Keys
  combos: '/combos',
  combo: '/combos/:id',
  aliases: '/aliases',
  alias: '/aliases/:id',
  mappings: '/mappings',
  mapping: '/mappings/:id',
  mappingsPreview: '/mappings/preview',
  filterRules: '/filter-rules',
  filterRule: '/filter-rules/:id',
  /** The compression pipeline's settings; a single record, so no `:id`. */
  tokenSaver: '/token-saver',
  /** The measured savings; listed first so it cannot be read as a sub-resource. */
  tokenSaverSavings: '/token-saver/savings',
  apiKeys: '/api-keys',
  apiKey: '/api-keys/:id',
  apiKeyRevoke: '/api-keys/:id/revoke',

  // Automation — Automation, Automation Logs, Proxy Pool, SMS Providers
  jobs: '/jobs',
  job: '/jobs/:id',
  jobControl: '/jobs/:id/control',
  jobManual: '/jobs/:id/manual',
  /**
   * Open a manual session on one item (FR-5.7): the operator is taking it over,
   * so the console's view is refreshed and the deadline restarts.
   */
  jobSession: '/jobs/:id/session',
  proxies: '/proxies',
  proxy: '/proxies/:id',
  proxiesCheck: '/proxies/check',
  /** Health tallies for the pool's summary tiles; `/proxies/:id` would swallow it. */
  proxiesSummary: '/proxies/summary',
  proxiesImport: '/proxies/import',
  smsProviders: '/sms-providers',
  smsProvider: '/sms-providers/:id',
  smsProvidersCheck: '/sms-providers/check',
  /** Balance tallies; `/sms-providers/:id` would swallow it. */
  smsProvidersSummary: '/sms-providers/summary',

  // Tools — Chat, Studio, Benchmark, Model Verification, Tools
  chatSessions: '/chat/sessions',
  chatSession: '/chat/sessions/:id',
  /**
   * Append a turn, and read the reply off the response as it is written.
   *
   * The one console route that does not answer with a document: the body is
   * `text/event-stream` carrying AI SDK UI Message frames, because the page paints
   * the first token before the last one exists.
   */
  chatMessages: '/chat/sessions/:id/messages',
  /**
   * The conversation as a file (FR-7.7).
   *
   * Four segments to `chatSession`'s three, so a literal `export` cannot be read
   * as a session id. Its own path rather than a query on the session, because what
   * it returns is not the session: it is a rendering of one, with a content type
   * and a filename the browser acts on.
   */
  chatExport: '/chat/sessions/:id/export',
  studioAssets: '/studio/assets',
  studioAsset: '/studio/assets/:id',
  /**
   * The bytes behind an asset. Four segments to `studioAsset`'s three, so a
   * literal `file` cannot be mistaken for an asset id.
   */
  studioAssetFile: '/studio/assets/:id/file',
  studioGenerations: '/studio/generations',
  studioGeneration: '/studio/generations/:id',
  /**
   * Stop a render that is still running (FR-8.5).
   *
   * A route rather than only the `studio_cancel` frame the WebSocket contract
   * already declares, because the Studio page polls: a console with no socket
   * has no way to send a frame, and a cancel button that cannot be pressed is
   * not a feature. The frame stays for a client that does hold a socket.
   */
  studioGenerationCancel: '/studio/generations/:id/cancel',
  benchmarks: '/benchmarks',
  benchmark: '/benchmarks/:id',
  verifications: '/verifications',
  verification: '/verifications/:id',
  /**
   * The reference distributions the probes compare against (FR-10.2).
   *
   * Its own path rather than a field on a result, because a baseline outlives
   * every result measured against it: it is calibrated once from an endpoint the
   * operator trusts, and every later verification reads it.
   */
  verificationsBaselines: '/verifications/baselines',
  /** Measure a reference from an endpoint the operator trusts. */
  verificationsCalibrate: '/verifications/calibrate',
  dotTrick: '/tools/dot-trick',
  vccCards: '/tools/vcc',
  vccCard: '/tools/vcc/:id',
  vccGenerate: '/tools/vcc/generate',
  /**
   * The one place a full card number leaves rutekit (FR-11.2).
   *
   * Its own path rather than a field on the card, so the read model never carries
   * a PAN and the decision to reveal one is a request an operator makes about one
   * card at a time.
   */
  vccReveal: '/tools/vcc/:id/reveal',
  /** The BIN catalogue; `/tools/vcc/:id` would swallow it, so it is listed first. */
  vccBins: '/tools/vcc/bins',

  // System — Customization, Settings, Auth
  /**
   * Instance introspection. Listed first because it is the route a client hits
   * before it knows anything else: which build is answering, how far the schema
   * has migrated, and since when.
   */
  meta: '/meta',
  customization: '/settings/customization',
  generalSettings: '/settings/general',
  authStatus: '/auth/status',
  authSetup: '/auth/setup',
  authLogin: '/auth/login',
  authLogout: '/auth/logout',
  authPassword: '/auth/password',
  backupManifest: '/backup/manifest',
  backup: '/backup',
  restore: '/restore',
} as const;

/** A named control-plane route template. */
export type ConsolePathName = keyof typeof consolePaths;
