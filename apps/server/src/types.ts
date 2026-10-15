import type { Logger } from 'pino';
import type { ProviderRegistry } from '@registry';

import type { AccountService } from '@server/accounts/service.ts';
import type { ApiKeyService } from '@server/api-keys/service.ts';
import type { KeyRateLimiter } from '@server/api-keys/limits.ts';
import type { JobManager } from '@server/automation/jobs/manager.ts';
import type { ProxyProbe } from '@server/automation/proxy-probe.ts';
import type { SmsChecker } from '@server/automation/sms-check.ts';
import type { AuthService } from '@server/auth/service.ts';
import type { BenchmarkCatalog } from '@server/benchmark/catalog.ts';
import type { BenchmarkRunner } from '@server/benchmark/runner.ts';
import type { VerificationService } from '@server/verification/service.ts';
import type { AbuseGuard } from '@server/ingress/abuse.ts';
import type { RandomSource } from '@shared';

import type { LogRing } from '@server/observability/log-ring.ts';
import type { AliasesRepository } from '@server/persistence/aliases.ts';
import type { Persistence } from '@server/persistence/client.ts';
import type { ChatRepository } from '@server/persistence/chat.ts';
import type { CombosRepository } from '@server/persistence/combos.ts';
import type { FilterRulesRepository } from '@server/persistence/filter-rules.ts';
import type { MappingsRepository } from '@server/persistence/mappings.ts';
import type { ConsoleAssets } from '@server/routes/console.ts';
import type { AppMetaRepository } from '@server/persistence/app-meta.ts';
import type { ProviderAccountsRepository } from '@server/persistence/provider-accounts.ts';
import type { ProxiesRepository } from '@server/persistence/proxies.ts';
import type { VccCardsRepository } from '@server/persistence/vcc.ts';
import type { RequestsRepository } from '@server/persistence/requests.ts';
import type { SmsProvidersRepository } from '@server/persistence/sms-providers.ts';
import type { ModelListing } from '@server/plan/listing.ts';
import type { Planner } from '@server/plan/plan.ts';
import type { Pool } from '@server/pool/pool.ts';
import type { Warmup } from '@server/pool/warmup.ts';
import type { ModelCatalog } from '@server/providers/model-catalog.ts';
import type { ProviderCatalog } from '@server/providers/provider-catalog.ts';
import type { ProviderService } from '@server/providers/provider-service.ts';
import type { ProviderOauthService } from '@server/providers/oauth/service.ts';
import type { ResponseFetcher } from '@server/providers/outbound.ts';
import type { RealtimeHub } from '@server/realtime/hub.ts';
import type { ServerConfig } from '@server/runtime/config.ts';
import type { GeneralSettingsStore } from '@server/runtime/general-settings.ts';
import type { Lifecycle } from '@server/runtime/lifecycle.ts';
import type { TokenSaverSettings } from '@server/runtime/token-saver.ts';
import type { SecretBox } from '@server/security/secret-box.ts';
import type { EgressPolicy } from '@server/security/egress.ts';
import type { StudioCatalog } from '@server/studio/catalog.ts';
import type { StudioQueue } from '@server/studio/queue.ts';
import type { TelemetryRecorder } from '@server/telemetry/recorder.ts';
import type { UsageService } from '@server/telemetry/usage.ts';

/**
 * Everything a route may reach, assembled once in the composition root.
 *
 * Passed as a single object rather than imported as module singletons: a route
 * that reaches for a global cannot be given a test double, and the whole point
 * of the boundary tests is that dependencies are visible in the call graph.
 */
export type AppDeps = {
  readonly config: ServerConfig;
  readonly logger: Logger;
  readonly lifecycle: Lifecycle;
  readonly persistence: Persistence;
  /**
   * The key/value store every single-record setting lives in (C13b).
   *
   * On `deps` rather than built where it is needed because four things already
   * read it — the boot timestamp, the Token Saver, the pool strategy, the general
   * settings — and the appearance record makes five. It is the same row store
   * either way; naming it once keeps a route from opening a second handle.
   */
  /**
   * The built console, if there is one (D3).
   *
   * `{ root: null }` in development, where Vite serves the console, and in any
   * checkout that has not run `bun run build`. `main.ts` locates it from the repo
   * root; a test decides for itself.
   */
  readonly console: ConsoleAssets;
  readonly meta: AppMetaRepository;
  readonly hub: RealtimeHub;
  readonly abuse: AbuseGuard;
  readonly auth: AuthService;
  readonly apiKeys: ApiKeyService;
  readonly keyLimiter: KeyRateLimiter;
  /**
   * Credential encryption. Null when `RUTEKIT_ENCRYPTION_KEY` is unset, which
   * makes credential storage unavailable rather than silently plaintext — a
   * provider account added without a key would otherwise be written in the clear.
   */
  readonly secrets: SecretBox | null;
  readonly egress: EgressPolicy;
  /**
   * The provider catalogue. Built once at boot rather than per request, because
   * `createProviderRegistry` is where a contradictory manifest is caught — and a
   * startup that refuses is the only way that check is worth anything.
   */
  readonly registry: ProviderRegistry;
  /** Provider sign-in over OAuth (C3b2), both the browser and device flows. */
  readonly providerOauth: ProviderOauthService;
  /**
   * The accounts a `/v1` turn can be sent as. Shared with `providerOauth`, which
   * is the only writer of a credential: this is the read side, and the pool (C5)
   * will be the only thing that chooses among them.
   */
  readonly accounts: ProviderAccountsRepository;
  /**
   * The pool (C5): which credential a turn is sent as, and how many are already
   * in flight. Also the source of the in-flight figure the console renders —
   * the column is only a mirror of the count this holds in memory.
   */
  readonly pool: Pool;
  /**
   * The warmup check-in (FR-3.5, FR-3.6). One authenticated round trip per
   * account per interval, proving the credential lives and refreshing its quota.
   */
  readonly warmup: Warmup;
  /**
   * Model id to provider. A separate value from the registry because the mapping
   * is a question the registry does not answer — it lists what exists, not who
   * serves a given id.
   */
  readonly catalog: ModelCatalog;
  /** Aliases (FR-1.3): a friendly name and the model id it means. */
  readonly aliases: AliasesRepository;
  /** Combos (FR-1.4): an ordered fallback chain behind one name. */
  readonly combos: CombosRepository;
  /** Model mapping rules (FR-1.5), read in priority order. */
  readonly mappings: MappingsRepository;
  /**
   * What a client's model name means (C5b): mapping, then alias, then combo, then
   * the catalogue. The dispatcher asks this and never the catalogue directly, so
   * the resolution order lives in exactly one place.
   */
  readonly planner: Planner;
  /** The `/v1/models` payload: the catalogue plus the operator's aliases and combos. */
  readonly modelListing: ModelListing;
  /**
   * The Providers section's read models (C13a).
   *
   * Two sources read as one: rutekit's curated manifests and the BYOK providers
   * an operator configured. On `deps` rather than built in the route because the
   * catalog page, the provider detail page and the accounts page all read the
   * same join.
   */
  readonly providerCatalog: ProviderCatalog;
  /** The Providers section's write side: create a BYOK provider, probe one, edit its models. */
  readonly providerService: ProviderService;
  /** Per-request telemetry (C6): the row every Overview read model derives from. */
  readonly requests: RequestsRepository;
  /** Where a turn writes its row, and what the inspector reads back. */
  readonly telemetry: TelemetryRecorder;
  /** The Usage page's summary, series and breakdown (FR-12.3). */
  readonly usage: UsageService;
  /**
   * The console log's ring (FR-12.1). A copy of what the process logs, held in
   * memory rather than in a table: a log is high-volume and diagnostic, and a
   * tail that starts empty after a restart is the right behaviour for one.
   */
  readonly logRing: LogRing;
  /** The instance's general settings, including the low-stress switch. */
  readonly settings: GeneralSettingsStore;
  /**
   * The account pool's console surface (C5a).
   *
   * Held on `deps` rather than built inside the route module because the job
   * manager needs the same one: a credential a worker imports is stored through
   * exactly the path an operator's hand-added account goes through, so it lands
   * in the pool with the same state machine and the same encryption.
   */
  readonly accountService: AccountService;
  /** Automation jobs (C7b): the batch, its worker, and its manual hand-off. */
  readonly jobs: JobManager;
  /** The automation's egress pool (C7a). A bulk import leaves through one of these. */
  readonly proxies: ProxiesRepository;
  /** The numbers a registration job rents (C7a). */
  readonly smsProviders: SmsProvidersRepository;
  /**
   * Whether a proxy still works. A real request through it, because a health
   * column that was guessed is worse than none.
   */
  readonly proxyProbe: ProxyProbe;
  /** The balance behind an activation key, read from the service's own account API. */
  readonly smsChecker: SmsChecker;
  /**
   * Conversations and their transcripts (C9, FR-7.7).
   *
   * A repository on `deps` rather than something only the chat route knows about,
   * for the reason the filter rules are: the transcript is the server's, and it is
   * what a turn is built from — the console sends one message, not a conversation.
   */
  readonly chatSessions: ChatRepository;
  /**
   * The Studio's render queue (C10, FR-8.1–8.6).
   *
   * On `deps` rather than built inside the route module because it outlives a
   * request: a render started by one submit keeps running after that response is
   * sent, and the socket's own cancel frame has to reach the same queue. Built
   * once at boot, like the job manager.
   */
  readonly studioQueue: StudioQueue;
  /** The Studio's read models: the gallery, the queue listing, and the bytes (C10). */
  readonly studioCatalog: StudioCatalog;
  /**
   * The benchmark runner (C11, FR-9.1).
   *
   * On `deps` for the reason the Studio queue is: a run outlives the request that
   * started it. It mints a key, spawns promptfoo, stores a matrix, and gives the
   * key back — all after the console's POST has already been answered.
   */
  readonly benchmarkRunner: BenchmarkRunner;
  /** The Benchmark's read models: the run list without its cells, and one run with (C11). */
  readonly benchmarkCatalog: BenchmarkCatalog;
  /**
   * Model verification (C12, FR-10.1–10.4).
   *
   * On `deps` rather than built inside the route module because it owns the
   * reference distributions as well as the verdicts: a calibration writes
   * baselines that every later verification reads, so the two have to be the same
   * instance or a fresh calibration would not be seen by the next run.
   */
  readonly verifications: VerificationService;
  /** The virtual-card pool (C8, FR-11.2). */
  readonly vccCards: VccCardsRepository;
  /** Client-supplied content filter rules (C8, FR-11.3), read by the pipeline. */
  readonly filterRules: FilterRulesRepository;
  /**
   * Randomness for the card generator (FR-11.2).
   *
   * On `deps` rather than reached for as a global, so a test can mint a
   * reproducible batch — a card number that changes on every run is a card number
   * a test cannot assert.
   */
  readonly random?: RandomSource;
  /**
   * The outbound call the provider layer makes, egress-checked. The same fetcher
   * `providerOauth` uses, held on `deps` so a route test can replace it and assert
   * what rutekit would have sent.
   */
  readonly fetch: ResponseFetcher;
  /** The Token Saver's stored configuration, read per request and fail-open. */
  readonly tokenSaver: TokenSaverSettings;
};

/**
 * Per-request values set by the ingress pipeline. Named in one place so a
 * handler reading `c.get('clientIp')` gets a string and not `unknown`.
 *
 * `sessionId` and `sessionExpiresAt` are set by the session guard, so they are
 * present on every console route behind it — which is every console route except
 * the four the guard leaves open, and none of those read them.
 */
export type AppVariables = {
  requestId: string;
  startedAtMs: number;
  clientIp: string;
  sessionId: string;
  sessionExpiresAt: string;
  /** Set by the API-key guard on `/v1/*`; absent on every console route. */
  apiKeyId: string;
};

export type AppEnv = { Variables: AppVariables };
