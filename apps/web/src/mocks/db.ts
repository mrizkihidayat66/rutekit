import type {
  Account,
  AccountState,
  Alias,
  ApiKey,
  ApiKeyInput,
  Asset,
  BenchmarkRun,
  ChatSession,
  Combo,
  Customization,
  Dashboard,
  FilterRule,
  GenerationJob,
  GeneralSettings,
  Job,
  JobStatus,
  LogEntry,
  ModelMappingRule,
  Provider,
  ProviderModel,
  Proxy,
  QuotaOverview,
  QuotaRow,
  RequestDetail,
  RequestLog,
  SmsProvider,
  SmsProviderInput,
  TimeWindow,
  TokenSaverConfig,
  TokenSaverConfigUpdate,
  TokenSaverSavings,
  UsageBreakdownDimension,
  UsageBreakdownRow,
  UsagePoint,
  UsageSummary,
  VccCard,
  VerificationResult,
} from '@contracts';
import { ROUTABLE_ACCOUNT_STATES } from '@contracts';

import { isoAt } from './clock.ts';
import { Rng } from './random.ts';
import { buildAccounts } from './fixtures/accounts.ts';
import { buildApiKeys } from './fixtures/api-keys.ts';
import { buildJobs, buildProxies, buildSmsProviders } from './fixtures/automation.ts';
import { buildAliases, buildCombos, buildFilterRules, buildMappings } from './fixtures/routing.ts';
import { buildProviders, modelRefs, type AccountCounts } from './fixtures/providers.ts';
import {
  buildAuthStatus,
  buildCreditPools,
  buildCustomization,
  buildGeneralSettings,
  buildSystemStatus,
} from './fixtures/system.ts';
import { buildTokenSaverConfig, buildTokenSaverSavings } from './fixtures/token-saver.ts';
import {
  LOG_COUNT,
  breakdown,
  bucketRequests,
  buildLiveLog,
  buildLogs,
  buildRequests,
  summarize,
} from './fixtures/telemetry.ts';
import {
  buildBenchmarks,
  buildChatSessions,
  buildStudio,
  buildVccCards,
  buildVerifications,
} from './fixtures/tools.ts';

/**
 * The in-memory stand-in for the server's database.
 *
 * Two rules make this worth having rather than letting each handler invent its
 * own response. First, every list the API returns is *derived* from the same
 * arrays, so a number on the dashboard and the row it came from can never
 * disagree. Second, every mutator writes back to those arrays, so a create or a
 * toggle in the UI survives a refetch — the one thing a static JSON mock cannot
 * do, and the reason the frontend can be built against this layer at all.
 */

/** Seeds are fixed so the pool is identical on every reload and in every test. */
const SEEDS = {
  accounts: 0x1a2b3c4d,
  providers: 0x5e6f7a8b,
  requests: 0x9c0d1e2f,
  logs: 0x3a4b5c6d,
  proxies: 0x2f3a4b5c,
  smsProviders: 0x71c4e9d2,
  jobs: 0x6b7c8d9e,
  studio: 0x7e8f9a0b,
  benchmarks: 0xbc1d2e3f,
  verifications: 0x4c5d6e7f,
  vcc: 0x8d9e0f1a,
  creditPools: 0xa1b2c3d4,
  system: 0xe5f6a7b8,
  tokenSaver: 0x2d4e6f80,
} as const;

/**
 * How long a mock quota check-in stays in flight. Long enough that the console
 * has time to show the sweep running — the flag exists to make that state
 * reachable, so it must not clear before the first poll can see it.
 */
const CHECK_IN_MS = 4_000;

/** How often the mock sweeps every provider's quota on its own. */
const SWEEP_INTERVAL_MS = 900_000;

/**
 * A patch whose keys may be present but `undefined`, which is exactly what a
 * zod `.partial()` parse produces. Plain `Partial<T>` rejects that under
 * `exactOptionalPropertyTypes`, so the mutators take this instead.
 */
export type Patch<T> = { [K in keyof T]?: T[K] | undefined };

export interface Pagination {
  cursor: string | null;
  limit: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

/** Cursors are plain offsets; opaque enough for the UI, trivial to decode. */
function decodeCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function paginate<T>(items: readonly T[], query: Pagination): Page<T> {
  const start = decodeCursor(query.cursor);
  const slice = items.slice(start, start + query.limit);
  const next = start + query.limit;
  return {
    items: slice,
    nextCursor: next < items.length ? String(next) : null,
    total: items.length,
  };
}

function toComparable(value: unknown): number | string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const asTime = Date.parse(value);
    return Number.isNaN(asTime) ? value.toLowerCase() : asTime;
  }
  // Objects and arrays have no meaningful order; treat them as equal so the
  // sort stays stable instead of collapsing to "[object Object]".
  return '';
}

function compare(left: number | string, right: number | string): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right));
}

/** Sort by a named field, tolerating the ISO strings every entity carries. */
export function sortBy<T>(
  items: readonly T[],
  field: string | null,
  direction: 'asc' | 'desc',
): T[] {
  if (field === null) return [...items];
  const sign = direction === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const left = toComparable((a as Record<string, unknown>)[field]);
    const right = toComparable((b as Record<string, unknown>)[field]);
    return compare(left, right) * sign;
  });
}

/** Spread a patch over a value, dropping keys the patch left `undefined`. */
function merge<T extends object>(base: T, patch: Patch<T>): T {
  const next: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) next[key] = value;
  }
  return next as T;
}

export function matches(haystack: readonly (string | null | undefined)[], needle: string): boolean {
  if (needle.trim() === '') return true;
  const lower = needle.trim().toLowerCase();
  return haystack.some((value) => (value ?? '').toLowerCase().includes(lower));
}

/**
 * The `first4••••last4` hint the read model returns in place of a secret.
 *
 * Applied here rather than in the handler because the array is the boundary: a
 * plaintext key that reaches `db.smsProviders` is a key that some future handler
 * can hand back by accident. Masking on the way in means the mock never holds one.
 */
function maskKey(secret: string): string {
  const value = secret.trim();
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

export interface MockDb {
  /* ---- state ---- */
  providers: Provider[];
  models: ProviderModel[];
  accounts: Account[];
  apiKeys: ApiKey[];
  aliases: Alias[];
  combos: Combo[];
  mappings: ModelMappingRule[];
  filterRules: FilterRule[];
  jobs: Job[];
  proxies: Proxy[];
  smsProviders: SmsProvider[];
  requests: RequestLog[];
  logs: LogEntry[];
  /** Counts the synthetic lines the live tail has emitted, so they stay unique. */
  liveSeq: number;
  chatSessions: ChatSession[];
  assets: Asset[];
  generations: GenerationJob[];
  benchmarks: BenchmarkRun[];
  verifications: VerificationResult[];
  vccCards: VccCard[];
  customization: Customization;
  generalSettings: GeneralSettings;
  tokenSaver: TokenSaverConfig;
  authStatus: ReturnType<typeof buildAuthStatus>;
  /**
   * Quota check-ins the mock has run, keyed by provider id: when the sweep was
   * asked for, and the epoch millisecond it finishes at. A deadline rather than
   * a boolean, so "in flight" clears itself and nothing has to remember to
   * unset it.
   */
  checkIns: Map<string, { readonly requestedAt: string; readonly until: number }>;
  /** When the next automatic sweep of every provider is due, in epoch ms. */
  sweepDueAt: number;

  /* ---- lookups ---- */
  provider(id: string): Provider | undefined;
  account(id: string): Account | undefined;
  apiKey(id: string): ApiKey | undefined;
  alias(id: string): Alias | undefined;
  combo(id: string): Combo | undefined;
  mapping(id: string): ModelMappingRule | undefined;
  filterRule(id: string): FilterRule | undefined;
  job(id: string): Job | undefined;
  proxy(id: string): Proxy | undefined;
  smsProvider(id: string): SmsProvider | undefined;
  request(id: string): RequestLog | undefined;
  chatSession(id: string): ChatSession | undefined;
  asset(id: string): Asset | undefined;
  generation(id: string): GenerationJob | undefined;
  benchmark(id: string): BenchmarkRun | undefined;
  verification(id: string): VerificationResult | undefined;
  vccCard(id: string): VccCard | undefined;
  modelsOf(providerId: string): ProviderModel[];
  /** One model of one provider, or undefined when the pair names nothing. */
  model(providerId: string, modelId: string): ProviderModel | undefined;
  /**
   * Replace a provider's discovered models, the way an auto-fetch would, and
   * keep the provider's own `modelCount` in step with the result.
   *
   * The operator's own entries survive: a re-fetch is a question about what the
   * endpoint advertises, not an instruction to delete what someone added.
   */
  setProviderModels(providerId: string, models: readonly ProviderModel[]): ProviderModel[];
  /** Append an operator-added model and re-count the provider. */
  addProviderModel(providerId: string, model: ProviderModel): void;
  /** Swap a model for its new shape in place; undefined when it is not there. */
  replaceProviderModel(
    providerId: string,
    modelId: string,
    next: ProviderModel,
  ): ProviderModel | undefined;
  /** Drop a model and re-count the provider; false when it was not there. */
  removeProviderModel(providerId: string, modelId: string): boolean;
  accountsOf(providerId: string): Account[];

  /* ---- derived reads ---- */
  dashboard(): Dashboard;
  usageSeries(window: TimeWindow): UsagePoint[];
  usageSummary(window: TimeWindow): UsageSummary;
  /**
   * The compression pipeline's measured savings. Derived from the current
   * config, so turning a stage off in the UI empties its bar on the next read
   * rather than leaving a figure that no longer has a cause.
   */
  tokenSaverSavings(window: TimeWindow): TokenSaverSavings;
  usageBreakdown(window: TimeWindow, dimension: UsageBreakdownDimension): UsageBreakdownRow[];
  quotaOverview(): QuotaOverview;
  /**
   * Put a quota sweep in flight for these providers. Nothing needs to finish it
   * — the flag expires on its own, which is what a real check-in looks like from
   * the console's side.
   */
  beginCheckIn(providerIds: readonly string[]): readonly string[];
  /** Per-level totals over `entries` (all logs by default). */
  logCounts(entries?: readonly LogEntry[]): Record<string, number>;
  requestDetail(id: string): RequestDetail | undefined;

  /* ---- mutators ---- */
  updateProvider(id: string, patch: Patch<Provider>): Provider | undefined;
  removeProvider(id: string): boolean;
  updateAccount(id: string, patch: Patch<Account>): Account | undefined;
  removeAccount(id: string): boolean;
  applyAccountState(ids: readonly string[], state: AccountState, reason: string | null): number;
  createApiKey(input: ApiKeyInput): { apiKey: ApiKey; secret: string };
  updateApiKey(id: string, patch: Patch<ApiKey>): ApiKey | undefined;
  revokeApiKey(id: string): ApiKey | undefined;
  removeApiKey(id: string): boolean;
  updateCustomization(patch: Patch<Customization>): Customization;
  updateGeneralSettings(patch: Patch<GeneralSettings>): GeneralSettings;
  updateTokenSaver(patch: TokenSaverConfigUpdate): TokenSaverConfig;
  controlJob(id: string, action: 'pause' | 'resume' | 'cancel' | 'retry_failed'): Job | undefined;
  updateProxy(id: string, patch: Patch<Proxy>): Proxy | undefined;
  removeProxy(id: string): boolean;
  createSmsProvider(input: SmsProviderInput): SmsProvider;
  updateSmsProvider(id: string, patch: Patch<SmsProvider>): SmsProvider | undefined;
  removeSmsProvider(id: string): boolean;
  toggleAlias(id: string, enabled: boolean): Alias | undefined;
  toggleCombo(id: string, enabled: boolean): Combo | undefined;
  toggleMapping(id: string, enabled: boolean): ModelMappingRule | undefined;
  toggleFilterRule(id: string, enabled: boolean): FilterRule | undefined;
  updateVccCard(id: string, patch: Patch<VccCard>): VccCard | undefined;
  /** Append one synthetic line to the tail so a followed log has something new. */
  appendLiveLog(): LogEntry;
  reset(): void;
}

export function createDb(): MockDb {
  const accountRng = new Rng(SEEDS.accounts);
  const accounts = buildAccounts(accountRng);

  const counts = new Map<string, AccountCounts>();
  for (const account of accounts) {
    const entry = counts.get(account.providerId) ?? { total: 0, active: 0 };
    entry.total += 1;
    if (ROUTABLE_ACCOUNT_STATES.includes(account.state)) entry.active += 1;
    counts.set(account.providerId, entry);
  }

  const providerRng = new Rng(SEEDS.providers);
  const { providers, models } = buildProviders(providerRng, counts);

  const apiKeys = buildApiKeys(new Rng(SEEDS.requests));
  const studioRng = new Rng(SEEDS.studio);
  const { assets, generations } = buildStudio(studioRng);

  const requests = buildRequests(new Rng(SEEDS.requests), {
    accounts: accounts.map((account) => ({ id: account.id, providerId: account.providerId })),
    apiKeyIds: apiKeys.map((key) => key.id),
    models: modelRefs(models),
  });

  const state = {
    providers,
    models,
    accounts,
    apiKeys,
    aliases: buildAliases(),
    combos: buildCombos(),
    mappings: buildMappings(),
    filterRules: buildFilterRules(),
    jobs: buildJobs(new Rng(SEEDS.jobs)),
    proxies: buildProxies(new Rng(SEEDS.proxies)),
    smsProviders: buildSmsProviders(new Rng(SEEDS.smsProviders)),
    requests,
    logs: buildLogs(new Rng(SEEDS.logs), requests),
    liveSeq: 0,
    chatSessions: buildChatSessions(),
    assets,
    generations,
    benchmarks: buildBenchmarks(new Rng(SEEDS.benchmarks)),
    verifications: buildVerifications(new Rng(SEEDS.verifications)),
    vccCards: buildVccCards(new Rng(SEEDS.vcc)),
    customization: buildCustomization(),
    generalSettings: buildGeneralSettings(),
    tokenSaver: buildTokenSaverConfig(),
    authStatus: buildAuthStatus(),
    checkIns: new Map<string, { requestedAt: string; until: number }>(),
    sweepDueAt: Date.now() + SWEEP_INTERVAL_MS,
  };

  const db: MockDb = {
    ...state,

    provider: (id) => db.providers.find((entry) => entry.id === id),
    account: (id) => db.accounts.find((entry) => entry.id === id),
    apiKey: (id) => db.apiKeys.find((entry) => entry.id === id),
    alias: (id) => db.aliases.find((entry) => entry.id === id),
    combo: (id) => db.combos.find((entry) => entry.id === id),
    mapping: (id) => db.mappings.find((entry) => entry.id === id),
    filterRule: (id) => db.filterRules.find((entry) => entry.id === id),
    job: (id) => db.jobs.find((entry) => entry.id === id),
    proxy: (id) => db.proxies.find((entry) => entry.id === id),
    smsProvider: (id) => db.smsProviders.find((entry) => entry.id === id),
    request: (id) => db.requests.find((entry) => entry.id === id),
    chatSession: (id) => db.chatSessions.find((entry) => entry.id === id),
    asset: (id) => db.assets.find((entry) => entry.id === id),
    generation: (id) => db.generations.find((entry) => entry.id === id),
    benchmark: (id) => db.benchmarks.find((entry) => entry.id === id),
    verification: (id) => db.verifications.find((entry) => entry.id === id),
    vccCard: (id) => db.vccCards.find((entry) => entry.id === id),
    modelsOf: (providerId) => db.models.filter((model) => model.providerId === providerId),
    model: (providerId, modelId) =>
      db.models.find((entry) => entry.providerId === providerId && entry.id === modelId),

    setProviderModels(providerId, models) {
      const kept = db.models.filter(
        (model) => model.providerId === providerId && model.source === 'custom',
      );
      const synced = models.map((model) => ({ ...model, providerId, source: 'synced' as const }));
      db.models = [
        ...db.models.filter((model) => model.providerId !== providerId),
        ...synced,
        ...kept,
      ];
      const provider = db.provider(providerId);
      if (provider !== undefined) provider.modelCount = synced.length + kept.length;
      return [...synced, ...kept];
    },

    addProviderModel(providerId, model) {
      db.models = [...db.models, model];
      const provider = db.provider(providerId);
      if (provider !== undefined) provider.modelCount = db.modelsOf(providerId).length;
    },

    replaceProviderModel(providerId, modelId, next) {
      const index = db.models.findIndex(
        (model) => model.providerId === providerId && model.id === modelId,
      );
      if (index === -1) return undefined;
      db.models[index] = next;
      return next;
    },

    removeProviderModel(providerId, modelId) {
      const before = db.models.length;
      db.models = db.models.filter(
        (model) => !(model.providerId === providerId && model.id === modelId),
      );
      if (db.models.length === before) return false;
      const provider = db.provider(providerId);
      if (provider !== undefined) provider.modelCount = db.modelsOf(providerId).length;
      return true;
    },
    accountsOf: (providerId) => db.accounts.filter((account) => account.providerId === providerId),

    dashboard(): Dashboard {
      const ready = db.providers.filter((entry) => entry.status === 'ready').length;
      const needsAuth = db.providers.filter((entry) => entry.status === 'needs_auth').length;
      const error = db.providers.filter((entry) => entry.status === 'error').length;
      const disabled = db.providers.filter((entry) => entry.status === 'disabled').length;
      const active = db.accounts.filter((entry) =>
        ROUTABLE_ACCOUNT_STATES.includes(entry.state),
      ).length;
      const cooldown = db.accounts.filter(
        (entry) => entry.state === 'rate_limited' || entry.state === 'exhausted',
      ).length;
      const unhealthy = db.accounts.filter(
        (entry) => entry.state === 'error' || entry.state === 'banned',
      ).length;
      const inFlight = db.accounts.reduce((total, entry) => total + entry.inFlight, 0);

      return {
        status: buildSystemStatus(new Rng(SEEDS.system), {
          lowStressMode: db.generalSettings.lowStressMode,
        }),
        traffic: bucketRequests(db.requests, '24h'),
        providers: { total: db.providers.length, ready, needsAuth, error, disabled },
        accounts: { total: db.accounts.length, active, inFlight, cooldown, unhealthy },
        recentErrors: db.requests.filter((entry) => entry.status >= 400).slice(0, 8),
        quotaPools: buildCreditPools(new Rng(SEEDS.creditPools)),
        apiKeys: db.apiKeys,
      };
    },

    usageSeries: (window) => bucketRequests(db.requests, window),
    usageSummary: (window) => summarize(db.requests, window),
    tokenSaverSavings: (window) =>
      buildTokenSaverSavings(new Rng(SEEDS.tokenSaver), window, db.tokenSaver),
    usageBreakdown: (window, dimension) =>
      breakdown(db.requests, window, dimension, {
        provider: (id) => db.provider(id)?.name ?? id,
        account: (id) => db.account(id)?.emailMasked ?? id,
        apiKey: (id) => db.apiKey(id)?.name ?? id,
      }),

    quotaOverview(): QuotaOverview {
      const nowMs = Date.now();

      /**
       * The check-in state for one provider. The entry is kept after it lands,
       * so a completed sweep leaves "last checked" behind it; the map only ever
       * holds one entry per provider, so it cannot grow.
       */
      const checkIn = (providerId: string): { checking: boolean; lastCheckedAt: string | null } => {
        const entry = db.checkIns.get(providerId);
        if (entry === undefined) return { checking: false, lastCheckedAt: null };
        return { checking: entry.until > nowMs, lastCheckedAt: entry.requestedAt };
      };

      const rows: QuotaRow[] = [];
      const pools = buildCreditPools(new Rng(SEEDS.creditPools));
      for (const provider of db.providers) {
        const accounts = db.accountsOf(provider.id);
        if (accounts.length === 0 && !pools.some((pool) => pool.providerId === provider.id))
          continue;
        const windows = new Map<
          number,
          { limit: number; remaining: number; resetAt: string | null }
        >();
        for (const account of accounts) {
          const { limit, windowSeconds } = account.quota;
          if (limit === null || windowSeconds === null) continue;
          const entry = windows.get(windowSeconds) ?? {
            limit: 0,
            remaining: 0,
            resetAt: account.quota.resetAt,
          };
          entry.limit += limit;
          entry.remaining += account.quota.remaining ?? 0;
          windows.set(windowSeconds, entry);
        }
        const sweep = checkIn(provider.id);
        rows.push({
          providerId: provider.id,
          providerName: provider.name,
          windows: [...windows.entries()].map(([windowSeconds, entry]) => ({
            windowSeconds,
            limit: entry.limit,
            remaining: entry.remaining,
            resetAt: entry.resetAt,
          })),
          creditPools: pools.filter((pool) => pool.providerId === provider.id),
          lastCheckedAt: sweep.lastCheckedAt ?? accounts[0]?.lastUsedAt ?? null,
          checking: sweep.checking,
        });
      }
      // The sweep runs on a fixed schedule, so the countdown is measured to a
      // deadline rather than sent as a fresh "15 minutes" each time. A relative
      // figure would jump backwards on every refetch.
      if (db.sweepDueAt <= nowMs) db.sweepDueAt = nowMs + SWEEP_INTERVAL_MS;
      return {
        rows,
        nextSweepInSeconds: Math.max(0, Math.ceil((db.sweepDueAt - nowMs) / 1000)),
      };
    },

    beginCheckIn(providerIds) {
      const requestedAt = isoAt(0);
      const until = Date.now() + CHECK_IN_MS;
      for (const providerId of providerIds) db.checkIns.set(providerId, { requestedAt, until });
      return providerIds;
    },

    logCounts(entries = db.logs): Record<string, number> {
      const counts: Record<string, number> = { debug: 0, info: 0, warn: 0, error: 0 };
      for (const entry of entries) counts[entry.level] = (counts[entry.level] ?? 0) + 1;
      return counts;
    },

    requestDetail(id): RequestDetail | undefined {
      const request = db.request(id);
      if (request === undefined) return undefined;
      const seed = new Rng(hash(id));
      const stages = [
        'client_request',
        'canonical',
        'upstream_request',
        'upstream_response',
        'client_response',
      ] as const;
      const labels: Record<(typeof stages)[number], string> = {
        client_request: 'Client request',
        canonical: 'Canonical form',
        upstream_request: 'Upstream request',
        upstream_response: 'Upstream response',
        client_response: 'Client response',
      };
      const panels = stages.map((stage, index) => {
        const present = index === 0 || index === stages.length - 1 || request.hasCapture;
        const body = present
          ? JSON.stringify(
              stage === 'client_request'
                ? {
                    model: request.model,
                    stream: request.streamed,
                    messages: [{ role: 'user', content: '[redacted]' }],
                  }
                : {
                    status: request.status,
                    usage: {
                      prompt_tokens: request.inputTokens,
                      completion_tokens: request.outputTokens,
                    },
                  },
              null,
              2,
            )
          : null;
        return {
          stage,
          label: labels[stage],
          body,
          byteSize: body === null ? null : body.length,
          truncated: present && seed.bool(0.2),
          redacted: stage === 'client_request' || stage === 'upstream_request',
        };
      });

      const routeTrace = [
        {
          kind: 'alias' as const,
          label: 'alias fast → gpt-4o-mini',
          detail: request.model === null ? null : 'Resolved from the `fast` alias.',
        },
        { kind: 'mapping' as const, label: 'no mapping applied', detail: null },
        {
          kind: 'combo' as const,
          label: 'combo daily-driver, entry 1',
          detail: 'Sequential; first healthy entry.',
        },
        {
          kind: 'filter' as const,
          label: '2 rules evaluated',
          detail: 'Redacted 1 match, blocked 0.',
        },
        {
          kind: 'account' as const,
          label: `account ${request.accountId ?? 'none'}`,
          detail: 'Leased from the provider pool.',
        },
      ];

      const prelude = Math.max(0, Math.round(request.latencyMs * 0.12));
      const timeline = [
        { stage: 'Route', atMs: 0, durationMs: prelude },
        { stage: 'Queue', atMs: prelude, durationMs: Math.round(request.latencyMs * 0.08) },
        {
          stage: 'Upstream',
          atMs: prelude + Math.round(request.latencyMs * 0.08),
          durationMs: Math.round(request.latencyMs * 0.7),
        },
        {
          stage: 'Stream',
          atMs: Math.round(request.latencyMs * 0.9),
          durationMs: Math.max(0, request.latencyMs - Math.round(request.latencyMs * 0.9)),
        },
      ];

      return { request, panels, routeTrace, timeline };
    },

    updateProvider(id, patch) {
      const provider = db.provider(id);
      if (provider === undefined) return undefined;
      Object.assign(provider, patch, { updatedAt: isoAt(0) });
      return provider;
    },

    removeProvider(id) {
      const index = db.providers.findIndex((entry) => entry.id === id);
      if (index === -1) return false;
      db.providers.splice(index, 1);
      db.models = db.models.filter((model) => model.providerId !== id);
      db.accounts = db.accounts.filter((account) => account.providerId !== id);
      return true;
    },

    updateAccount(id, patch) {
      const account = db.account(id);
      if (account === undefined) return undefined;
      Object.assign(account, patch, { updatedAt: isoAt(0) });
      return account;
    },

    removeAccount(id) {
      const index = db.accounts.findIndex((entry) => entry.id === id);
      if (index === -1) return false;
      db.accounts.splice(index, 1);
      return true;
    },

    applyAccountState(ids, state, reason) {
      let changed = 0;
      for (const id of ids) {
        const account = db.account(id);
        if (account === undefined) continue;
        account.state = state;
        account.stateReason = reason;
        account.inFlight = 0;
        if (state !== 'rate_limited' && state !== 'exhausted') account.cooldownUntil = null;
        account.consecutiveFailures = state === 'active' ? 0 : account.consecutiveFailures;
        account.updatedAt = isoAt(0);
        changed += 1;
      }
      return changed;
    },

    createApiKey(input) {
      const id = `key_${Math.random().toString(36).slice(2, 10)}`;
      const prefix = `rk-${Math.random().toString(16).slice(2, 6)}`;
      const secret = `rk-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
      const apiKey: ApiKey = {
        id,
        name: input.name,
        prefix,
        modelsAllowed: input.modelsAllowed,
        modelsDenied: input.modelsDenied,
        budgetRequests: input.budgetRequests,
        budgetTokens: input.budgetTokens,
        tpsLimit: input.tpsLimit,
        rateLimitPerMinute: input.rateLimitPerMinute,
        expiresAt: input.expiresAt,
        clientRouterDenylist: input.clientRouterDenylist,
        revokedAt: null,
        lastUsedAt: null,
        usage: { requests: 0, inputTokens: 0, outputTokens: 0 },
        createdAt: isoAt(0),
      };
      db.apiKeys.unshift(apiKey);
      return { apiKey, secret };
    },

    updateApiKey(id, patch) {
      const apiKey = db.apiKey(id);
      if (apiKey === undefined) return undefined;
      Object.assign(apiKey, patch);
      return apiKey;
    },

    revokeApiKey(id) {
      const apiKey = db.apiKey(id);
      if (apiKey === undefined) return undefined;
      apiKey.revokedAt = isoAt(0);
      return apiKey;
    },

    removeApiKey(id) {
      const index = db.apiKeys.findIndex((entry) => entry.id === id);
      if (index === -1) return false;
      db.apiKeys.splice(index, 1);
      return true;
    },

    updateCustomization(patch) {
      db.customization = merge(db.customization, patch);
      return db.customization;
    },

    updateGeneralSettings(patch) {
      db.generalSettings = merge(db.generalSettings, patch);
      return db.generalSettings;
    },

    updateTokenSaver(patch) {
      // The two maps merge key-by-key rather than being replaced whole, so a
      // caller may send either one toggle or the full set a preset produces and
      // both land correctly. `merge` above cannot do it: a nested object would
      // be swapped in and the keys it omitted would vanish.
      db.tokenSaver = {
        ...merge(db.tokenSaver, patch),
        stages: { ...db.tokenSaver.stages, ...patch.stages },
        rtkFilters: { ...db.tokenSaver.rtkFilters, ...patch.rtkFilters },
        updatedAt: isoAt(0),
      };
      return db.tokenSaver;
    },

    controlJob(id, action) {
      const job = db.job(id);
      if (job === undefined) return undefined;
      const terminal: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];
      if (action === 'pause' && !terminal.includes(job.status)) job.status = 'paused';
      if (action === 'resume' && job.status === 'paused') job.status = 'running';
      if (action === 'cancel' && !terminal.includes(job.status)) {
        job.status = 'cancelled';
        job.finishedAt = isoAt(0);
      }
      if (action === 'retry_failed') {
        for (const item of job.items) {
          if (item.status === 'failed') {
            item.status = 'queued';
            item.attempts = 0;
            item.lastError = null;
          }
        }
        job.status = 'running';
        job.failed = 0;
        job.finishedAt = null;
      }
      return job;
    },

    updateProxy(id, patch) {
      const proxy = db.proxy(id);
      if (proxy === undefined) return undefined;
      Object.assign(proxy, patch, { updatedAt: isoAt(0) });
      return proxy;
    },

    removeProxy(id) {
      const index = db.proxies.findIndex((entry) => entry.id === id);
      if (index === -1) return false;
      db.proxies.splice(index, 1);
      return true;
    },

    createSmsProvider(input) {
      const provider: SmsProvider = {
        id: `sms_${Math.random().toString(36).slice(2, 10)}`,
        kind: input.kind,
        label: input.label,
        // The key itself is accepted and dropped: the read model returns only
        // the masked hint, so the mock never holds a secret it could leak.
        keyHint: maskKey(input.apiKey),
        status: 'untested',
        balance: null,
        currency: null,
        country: input.country,
        operator: input.operator,
        product: input.product,
        successCount: 0,
        failCount: 0,
        lastCheckedAt: null,
        note: input.note,
        createdAt: isoAt(0),
        updatedAt: isoAt(0),
      };
      db.smsProviders.unshift(provider);
      return provider;
    },

    updateSmsProvider(id, patch) {
      const provider = db.smsProvider(id);
      if (provider === undefined) return undefined;
      Object.assign(provider, patch, { updatedAt: isoAt(0) });
      return provider;
    },

    removeSmsProvider(id) {
      const index = db.smsProviders.findIndex((entry) => entry.id === id);
      if (index === -1) return false;
      db.smsProviders.splice(index, 1);
      return true;
    },

    toggleAlias(id, enabled) {
      const alias = db.alias(id);
      if (alias === undefined) return undefined;
      alias.enabled = enabled;
      alias.updatedAt = isoAt(0);
      return alias;
    },

    toggleCombo(id, enabled) {
      const combo = db.combo(id);
      if (combo === undefined) return undefined;
      combo.enabled = enabled;
      combo.updatedAt = isoAt(0);
      return combo;
    },

    toggleMapping(id, enabled) {
      const mapping = db.mapping(id);
      if (mapping === undefined) return undefined;
      mapping.enabled = enabled;
      mapping.updatedAt = isoAt(0);
      return mapping;
    },

    toggleFilterRule(id, enabled) {
      const rule = db.filterRule(id);
      if (rule === undefined) return undefined;
      rule.enabled = enabled;
      rule.updatedAt = isoAt(0);
      return rule;
    },

    updateVccCard(id, patch) {
      const card = db.vccCard(id);
      if (card === undefined) return undefined;
      Object.assign(card, patch, { updatedAt: isoAt(0) });
      return card;
    },

    appendLiveLog() {
      db.liveSeq += 1;
      const entry = buildLiveLog(db.liveSeq, db.requests, isoAt(0));
      db.logs.unshift(entry);
      // A fixed-size ring: the tail grows at the head and the oldest lines fall
      // off, so a session that follows the log for an hour cannot grow the mock
      // without bound.
      if (db.logs.length > LOG_COUNT) db.logs.length = LOG_COUNT;
      return entry;
    },

    reset() {
      const fresh = createDb();
      Object.assign(db, fresh);
    },
  };

  return db;
}

/** Deterministic 32-bit hash, used to make per-request detail stable. */
function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export const db: MockDb = createDb();
