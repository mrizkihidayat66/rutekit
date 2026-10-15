import type {
  AccountsQuery,
  ApiKeysQuery,
  ChatSessionsQuery,
  JobsQuery,
  LogsQuery,
  ModelsQuery,
  ProvidersQuery,
  ProxiesQuery,
  RequestsQuery,
  SearchQuery,
  SmsProvidersQuery,
  StudioAssetsQuery,
  StudioGenerationsQuery,
  TimeWindow,
  UsageBreakdownDimension,
  VccCardsQuery,
  VerificationsQuery,
} from '@contracts';

/**
 * Every TanStack Query key in one place (RULESET R6.2).
 *
 * Keys are built from the contract's own query types rather than loose strings,
 * so a key and the request it identifies cannot drift: the same object that
 * forms the key is what the fetcher serialises into the query string. An
 * `invalidateQueries` call therefore names exactly the cache it means to drop.
 *
 * `cursor` is deliberately excluded from the list keys — a paginated view is one
 * cache entry (`useInfiniteQuery`), not one entry per page.
 */

export const queryKeys = {
  dashboard: () => ['dashboard'] as const,

  usageSummary: (window: TimeWindow) => ['usage', 'summary', window] as const,
  usageSeries: (window: TimeWindow) => ['usage', 'series', window] as const,
  usageBreakdown: (window: TimeWindow, dimension: UsageBreakdownDimension) =>
    ['usage', 'breakdown', window, dimension] as const,

  requests: (query: Omit<RequestsQuery, 'cursor'>) => ['requests', 'list', query] as const,
  request: (id: string) => ['requests', 'detail', id] as const,

  logs: (query: Omit<LogsQuery, 'cursor'>) => ['logs', 'list', query] as const,

  providers: (query: Omit<ProvidersQuery, 'cursor'>) => ['providers', 'list', query] as const,
  provider: (id: string) => ['providers', 'detail', id] as const,
  providerModels: (id: string) => ['providers', 'models', id] as const,
  models: (query: Omit<ModelsQuery, 'cursor'>) => ['models', 'list', query] as const,

  accounts: (query: Omit<AccountsQuery, 'cursor'>) => ['accounts', 'list', query] as const,

  quota: () => ['quota'] as const,

  combos: (query: Omit<SearchQuery, 'cursor'>) => ['combos', 'list', query] as const,
  combo: (id: string) => ['combos', 'detail', id] as const,
  aliases: (query: Omit<SearchQuery, 'cursor'>) => ['aliases', 'list', query] as const,
  alias: (id: string) => ['aliases', 'detail', id] as const,
  mappings: (query: Omit<SearchQuery, 'cursor'>) => ['mappings', 'list', query] as const,
  mapping: (id: string) => ['mappings', 'detail', id] as const,
  filterRules: (query: Omit<SearchQuery, 'cursor'>) => ['filter-rules', 'list', query] as const,
  filterRule: (id: string) => ['filter-rules', 'detail', id] as const,
  apiKeys: (query: Omit<ApiKeysQuery, 'cursor'>) => ['api-keys', 'list', query] as const,
  apiKey: (id: string) => ['api-keys', 'detail', id] as const,

  /** The pipeline is one record, so its key needs no id. */
  tokenSaver: () => ['token-saver', 'config'] as const,
  tokenSaverSavings: (window: TimeWindow) => ['token-saver', 'savings', window] as const,

  jobs: (query: Omit<JobsQuery, 'cursor'>) => ['jobs', 'list', query] as const,
  job: (id: string) => ['jobs', 'detail', id] as const,
  proxies: (query: Omit<ProxiesQuery, 'cursor'>) => ['proxies', 'list', query] as const,
  proxy: (id: string) => ['proxies', 'detail', id] as const,
  proxiesSummary: () => ['proxies', 'summary'] as const,

  smsProviders: (query: Omit<SmsProvidersQuery, 'cursor'>) => ['sms-providers', 'list', query] as const,
  smsProvider: (id: string) => ['sms-providers', 'detail', id] as const,
  smsProvidersSummary: () => ['sms-providers', 'summary'] as const,

  chatSessions: (query: Omit<ChatSessionsQuery, 'cursor'>) => ['chat', 'sessions', query] as const,
  chatSession: (id: string) => ['chat', 'session', id] as const,

  studioAssets: (query: Omit<StudioAssetsQuery, 'cursor'>) => ['studio', 'assets', query] as const,
  studioAsset: (id: string) => ['studio', 'asset', id] as const,
  studioGenerations: (query: Omit<StudioGenerationsQuery, 'cursor'>) =>
    ['studio', 'generations', query] as const,
  studioGeneration: (id: string) => ['studio', 'generation', id] as const,

  benchmarks: (query: Omit<ChatSessionsQuery, 'cursor'>) => ['benchmarks', 'list', query] as const,
  benchmark: (id: string) => ['benchmarks', 'detail', id] as const,

  verifications: (query: Omit<VerificationsQuery, 'cursor'>) => ['verifications', 'list', query] as const,
  verification: (id: string) => ['verifications', 'detail', id] as const,

  vccCards: (query: Omit<VccCardsQuery, 'cursor'>) => ['vcc', 'list', query] as const,
  vccCard: (id: string) => ['vcc', 'detail', id] as const,
  /** The BIN catalogue. Unpaged and static, so it has no query to key on. */
  vccBins: () => ['vcc', 'bins'] as const,

  customization: () => ['system', 'customization'] as const,
  generalSettings: () => ['system', 'general'] as const,
  authStatus: () => ['system', 'auth'] as const,
  backupManifest: () => ['system', 'backup-manifest'] as const,
} as const;
