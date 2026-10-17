import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveProviderRegistry, createProviderRegistry } from '@registry';
import type { Fetcher } from '@registry';
import type { ProviderRegistry } from '@registry';
import { providerManifests } from '@registry/providers/index.ts';
import { createIdFactory, type RandomSource } from '@shared';
import { NO_CONSOLE, type ConsoleAssets } from '@server/routes/console.ts';

import { createAccountService } from '@server/accounts/service.ts';
import { KeyRateLimiter } from '@server/api-keys/limits.ts';
import { createApiKeyService } from '@server/api-keys/service.ts';
import type { CapacityOptions } from '@server/automation/capacity.ts';
import { createJobManager, type Timers } from '@server/automation/jobs/manager.ts';
import type { WorkerLauncher } from '@server/automation/launcher.ts';
import { createProxyProbe, type ProxyProbe } from '@server/automation/proxy-probe.ts';
import { createSmsChecker, type SmsChecker } from '@server/automation/sms-check.ts';
import { createAuthService } from '@server/auth/service.ts';
import { AbuseGuard } from '@server/ingress/abuse.ts';
import { createLogRing } from '@server/observability/log-ring.ts';
import { silentLogger } from '@server/observability/logger.ts';
import { createAliasesRepository } from '@server/persistence/aliases.ts';
import { createApiKeysRepository } from '@server/persistence/api-keys.ts';
import { createAppMetaRepository, type AppMetaRepository } from '@server/persistence/app-meta.ts';
import { createAuthCredentialRepository } from '@server/persistence/auth-credential.ts';
import { openPersistence } from '@server/persistence/client.ts';
import { createChatRepository } from '@server/persistence/chat.ts';
import { createCombosRepository } from '@server/persistence/combos.ts';
import { createBenchmarkCatalog } from '@server/benchmark/catalog.ts';
import type { BenchmarkEngine } from '@server/benchmark/engine.ts';
import { createBenchmarkRunner } from '@server/benchmark/runner.ts';
import { createBenchmarkRepository } from '@server/persistence/benchmark.ts';
import { createVerificationRepository } from '@server/persistence/verification.ts';
import { createProviderRepository } from '@server/persistence/providers.ts';
import { createProviderCatalog } from '@server/providers/provider-catalog.ts';
import { createProviderService } from '@server/providers/provider-service.ts';
import { storedProviderManifests } from '@server/providers/stored-manifests.ts';
import { createStudioRepository } from '@server/persistence/studio.ts';
import { createProbeRunner } from '@server/verification/probe-runner.ts';
import { createVerificationService } from '@server/verification/service.ts';
import { createStudioCatalog } from '@server/studio/catalog.ts';
import { createMediaDrivers, type MediaDrivers } from '@server/studio/driver.ts';
import { createStudioQueue } from '@server/studio/queue.ts';
import { createAssetStorage, type AssetStorage } from '@server/studio/storage.ts';
import { createMappingsRepository } from '@server/persistence/mappings.ts';
import { runMigrations } from '@server/persistence/migrate.ts';
import { createJobsRepository } from '@server/persistence/jobs.ts';
import { createFilterRulesRepository } from '@server/persistence/filter-rules.ts';
import { createProviderAccountsRepository } from '@server/persistence/provider-accounts.ts';
import { createProxiesRepository } from '@server/persistence/proxies.ts';
import { createVccCardsRepository } from '@server/persistence/vcc.ts';
import { createRequestsRepository } from '@server/persistence/requests.ts';
import { createSessionsRepository } from '@server/persistence/sessions.ts';
import { createSmsProvidersRepository } from '@server/persistence/sms-providers.ts';
import { createModelListing } from '@server/plan/listing.ts';
import { createPlanner } from '@server/plan/plan.ts';
import { createPool } from '@server/pool/pool.ts';
import { createPoolStrategySettings } from '@server/pool/strategy.ts';
import { createWarmup } from '@server/pool/warmup.ts';
import { nodeCrypto } from '@server/providers/codec-crypto.ts';
import { createModelCatalog } from '@server/providers/model-catalog.ts';
import { createPendingFlows } from '@server/providers/oauth/pending.ts';
import { createProviderOauthService } from '@server/providers/oauth/service.ts';
import {
  createOutboundFetcher,
  createOutboundResponseFetcher,
} from '@server/providers/outbound.ts';
import type { ResponseFetcher } from '@server/providers/outbound.ts';
import { RealtimeHub } from '@server/realtime/hub.ts';
import { parseConfig } from '@server/runtime/config.ts';
import { createGeneralSettings } from '@server/runtime/general-settings.ts';
import { Lifecycle } from '@server/runtime/lifecycle.ts';
import { createTokenSaverSettings } from '@server/runtime/token-saver.ts';
import { EgressPolicy } from '@server/security/egress.ts';
import type { SecretBox } from '@server/security/secret-box.ts';
import { createTelemetryRecorder } from '@server/telemetry/recorder.ts';
import { createUsageService } from '@server/telemetry/usage.ts';
import type { AppDeps } from '@server/types.ts';

/**
 * A whole server, assembled the way `main.ts` assembles one, over an in-memory
 * database.
 *
 * Not a `.test.ts`, so the runner does not treat it as a suite. The point is
 * that the tests exercise the real composition — the same `AppDeps`, the same
 * migration list, the same hub — rather than a hand-built approximation of it.
 * The only things swapped out are the clock-free parts: a silent logger, an
 * in-memory database, and a temporary directory that never gets written to.
 */

export interface TestServer extends AppDeps {
  readonly meta: AppMetaRepository;
  /**
   * The temp directory the server was given as `RUTEKIT_DATA_DIR`.
   *
   * Exposed because the Studio writes real files into it, and a test that wants
   * to assert what happens when one goes missing has to be able to delete it.
   */
  readonly dataDir: string;
  /** Releases the database handle. Call from `afterEach`. */
  readonly close: () => void;
}

export interface MakeServerOptions {
  /** Low values make the abuse ceiling reachable in a test. */
  readonly maxRequests?: number;
  /**
   * Answers in place of the network, so a test can stand in for a provider.
   * Defaults to the real egress-checked fetcher, which would refuse to leave.
   */
  readonly fetch?: ResponseFetcher;
  /**
   * The registry-shaped fetcher (C13a).
   *
   * Probing and model discovery are the registry's own readers, and they take a
   * different shape from the data plane's — a `Fetcher` answers with a status and
   * `text()`, which is all a probe needs. Injectable separately so a test can
   * stand in for an endpoint without also standing in for a chat call.
   */
  readonly providerFetch?: Fetcher;
  /**
   * A real box, so a test can store a credential the dispatcher can decrypt. The
   * default is null, which is the honest state of a fresh install and the one
   * that makes a sign-in unavailable.
   */
  readonly secrets?: SecretBox | null;
  /** Extra `RUTEKIT_*` values, so a test can shorten a timeout it means to hit. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The planner's randomness, for a test that needs a weighted combo's head to be
   * a particular entry rather than a distribution.
   */
  readonly random?: RandomSource;
  /**
   * The automation's two network seams (C7a).
   *
   * Both make a real call in production — a proxy check goes through the proxy,
   * a balance check goes to the activation service — so a test that means to
   * assert what happens to the *verdict* has to stand in for the network. The
   * defaults answer "nothing works", which is the honest state of a test box with
   * no outbound access and makes a test that forgot to inject one obvious.
   */
  readonly proxyProbe?: ProxyProbe;
  readonly smsChecker?: SmsChecker;
  /**
   * How a job's worker is launched (C7b).
   *
   * The default is a fake that reports a job-level failure, so a test that meant
   * to inject one and forgot sees a failure rather than a real Node process
   * spawning from a unit test.
   */
  readonly workerLauncher?: WorkerLauncher;
  /**
   * The manager's clocks. A manual deadline is measured in minutes in
   * production, so a test that has to wait it out is a test that takes minutes.
   */
  readonly timers?: Timers;
  /**
   * What the machine can carry (FR-5.8).
   *
   * Injectable so a test can describe a small machine rather than run on whatever
   * the CI box happens to be: the cap is a policy about cores and memory, and a
   * test asserting it against real hardware would pass or fail by accident.
   */
  readonly capacity?: CapacityOptions;
  /**
   * The provider catalogue.
   *
   * Injectable because every shipped provider declares an automation block, so
   * the branch that refuses a provider rutekit cannot drive has no case in the
   * real catalogue — and an untested branch is where the bug lives.
   */
  readonly registry?: ProviderRegistry;
  /**
   * The Studio's media drivers (C10).
   *
   * Injectable because the only shipped driver is ComfyUI's, and it wants a real
   * instance on the operator's machine — so without a seam here, every test of
   * the queue, the asset storage and the routes would be a test of nothing. The
   * default is an empty registry, which is the honest state of a machine that
   * has not configured a renderer.
   */
  readonly mediaDrivers?: MediaDrivers;
  /** Where generated files go. Defaults to a directory inside the temp data dir. */
  readonly studioStorage?: AssetStorage;
  /**
   * The benchmark engine (C11).
   *
   * Injectable because the real one spawns promptfoo, which is minutes of work
   * and a real child process — so without a seam here every test of the runner,
   * the parser and the routes would be a test of nothing. The default is null,
   * which is the honest state of a machine that has not installed it: a run
   * fails with the sentence about installing it.
   */
  readonly benchmarkEngine?: BenchmarkEngine | null;
  /** Renders to run at once. Two by default, matching the shipped config. */
  readonly studioConcurrency?: number;
  /** Ceiling on one render. Short by default, so a hung test fails rather than waits. */
  readonly studioTimeoutMs?: number;
  /** The built console to serve (D3). Defaults to none, as in development. */
  readonly console?: ConsoleAssets;
}

export function makeServer(options: MakeServerOptions = {}): TestServer {
  // Kept in a local rather than created inline: the Studio writes real files, and
  // a test that wants to look at what landed needs the directory it landed in.
  const dataDir = mkdtempSync(join(tmpdir(), 'rutekit-test-'));
  const persistence = openPersistence({ databaseUrl: ':memory:', dataDir });
  runMigrations(persistence.sqlite);

  // Paths are never touched by a route, so the root only has to be a string.
  const config = parseConfig({ RUTEKIT_DATABASE_URL: ':memory:', ...options.env }, process.cwd());
  const logger = silentLogger();
  const secrets = options.secrets ?? null;
  const egress = new EgressPolicy(config.egressAllowlist);
  // Live, exactly as `main.ts` builds it: a test that creates a BYOK provider
  // through the console is exercising the same merge the server does, so a
  // provider the console can create is one the router can also reach.
  const providerRepo = createProviderRepository({ db: persistence.db });
  const registry =
    options.registry ??
    createLiveProviderRegistry(createProviderRegistry(providerManifests), () =>
      storedProviderManifests(providerRepo),
    );
  const accounts = createProviderAccountsRepository(persistence.db);
  const meta = createAppMetaRepository(persistence.db);
  // Built before the job manager, which publishes to it.
  const hub = new RealtimeHub(logger, { heartbeatSeconds: 30 });
  const providerOauth = createProviderOauthService({
    registry,
    accounts,
    // No key in the test config, so a sign-in is honestly unavailable — which is
    // the path a route test should see unless it builds its own service.
    secrets,
    pending: createPendingFlows(),
    logger,
    consoleOrigin: config.consoleOrigin,
    fetch: options.providerFetch ?? createOutboundFetcher({ egress }),
  });

  // One fetcher shared by the data plane and the warmup probe, the same way
  // `main.ts` shares it, so a test that replaces `fetch` replaces both.
  const responseFetch = options.fetch ?? createOutboundResponseFetcher({ egress });
  const poolStrategy = createPoolStrategySettings({ meta });

  // The plan (C5b), assembled the way `main.ts` assembles it — including the
  // deterministic random source, so a weighted combo's head is assertable.
  const aliases = createAliasesRepository(persistence.db);
  const combos = createCombosRepository(persistence.db);
  const mappings = createMappingsRepository(persistence.db);
  const catalog = createModelCatalog({ registry });

  // The general settings record and the telemetry that reads it (C6). A test
  // flips the switches through `settings.write`, which is what the console does.
  const settings = createGeneralSettings({ meta });
  // Kept in a local as well as on `deps`: `close()` below has to stop it before
  // the database goes away, and reaching back through the deps object would mean
  // this factory depending on its own return value.
  const warmup = createWarmup({
    registry,
    accounts,
    secrets,
    fetch: responseFetch,
    config,
    logger,
    ids: createIdFactory((bytes) => crypto.getRandomValues(new Uint8Array(bytes))),
    crypto: nodeCrypto,
  });
  const requests = createRequestsRepository(persistence.db);
  const telemetry = createTelemetryRecorder({
    requests,
    logger,
    captureEnabled: () => settings.read().payloadCaptureEnabled,
    captureTtlMinutes: () => settings.read().payloadCaptureTtlMinutes,
    retentionMinutes: () => settings.read().telemetryRetentionMinutes,
  });

  const planner = createPlanner({
    catalog,
    aliases,
    combos,
    mappings,
    lowStress: () => settings.read().lowStressMode,
    random: options.random ?? ((bytes) => crypto.getRandomValues(new Uint8Array(bytes))),
  });

  // The automation's two pools (C7a), with the network replaced. The real probe
  // and checker are built the way `main.ts` builds them, so a test that injects
  // nothing still exercises the same code path — it just reaches nothing.
  const proxies = createProxiesRepository(persistence.db);
  const smsProviders = createSmsProvidersRepository(persistence.db);
  // The tools (C8): a card pool and the operator's own content rules, the latter
  // read by the data plane on every turn.
  const vccCards = createVccCardsRepository(persistence.db);
  const filterRules = createFilterRulesRepository(persistence.db);
  // Chat (C9): the console's conversations, read by a turn to build its request.
  const chatSessions = createChatRepository(persistence.db);

  // The Studio (C10). The storage root is a real temp directory rather than a
  // stub, because writing and reading a file back is the thing under test in
  // half of what follows — and a fake filesystem would only prove the fake.
  const studioRepo = createStudioRepository({ db: persistence.db });
  const studioStorage = options.studioStorage ?? createAssetStorage({ dataDir });
  const studioCatalog = createStudioCatalog({ studio: studioRepo, storage: studioStorage });
  // One instance, shared with the routes below: a benchmark mints its key
  // through exactly the path an operator's key goes through, which is what makes
  // the run's scope and its revocation real rather than simulated.
  const apiKeys = createApiKeyService({ apiKeys: createApiKeysRepository(persistence.db) });

  // Benchmarks (C11). The engine defaults to null so a test that does not care
  // about benchmarks sees the honest "not installed" path.
  const benchmarkRepo = createBenchmarkRepository({ db: persistence.db });
  const benchmarkRunner = createBenchmarkRunner({
    runs: benchmarkRepo,
    apiKeys,
    engine: options.benchmarkEngine ?? null,
    baseUrl: config.loopbackOrigin,
    workspaceRoot: join(dataDir, 'benchmark'),
    providerSource: join(config.repoRoot, 'tools', 'benchmark-provider', 'provider.cjs'),
    maxConcurrency: config.benchmarkConcurrency,
    logger,
  });
  const benchmarkCatalog = createBenchmarkCatalog({ runs: benchmarkRepo });

  const studioQueue = createStudioQueue({
    studio: studioRepo,
    drivers: options.mediaDrivers ?? createMediaDrivers({ drivers: [] }),
    storage: studioStorage,
    registry,
    logger,
    concurrency: options.studioConcurrency ?? 2,
    timeoutMs: options.studioTimeoutMs ?? 30_000,
    publish: (job) => {
      hub.publish('studio', { type: 'studio_progress', generation: job });
    },
  });
  const proxyProbe =
    options.proxyProbe ??
    createProxyProbe({
      egress,
      probeUrl: config.proxyProbeUrl,
      timeoutMs: config.proxyProbeTimeoutMs,
      fetch: () => Promise.reject(new Error('no network in tests')),
    });
  const smsChecker =
    options.smsChecker ?? createSmsChecker({ fetch: responseFetch, timeoutMs: 5_000 });

  // The account service is shared with the job manager, the same way `main.ts`
  // shares it: a credential a worker imports is stored through the same path an
  // operator's hand-added account goes through.
  const pool = createPool({ registry, accounts, secrets, strategy: () => poolStrategy.read(), logger });

  // Verification (C12). It probes through the same `callModel` the data plane
  // uses, so a test that replaces `fetch` reaches it too.
  const verificationRepo = createVerificationRepository({ db: persistence.db });
  const probeRunner = createProbeRunner({
    catalog,
    call: {
      pool,
      tokenSaver: createTokenSaverSettings({ meta }),
      persistCredential: () => undefined,
      // No content filters, matching `main.ts`: a filter that rewrote a probe
      // would change what the endpoint was asked, which is the one thing a
      // measurement must not do.
      filters: () => [],
      fetch: responseFetch,
      config,
      logger,
      now: () => Math.floor(Date.now() / 1000),
      ids: createIdFactory((bytes) => crypto.getRandomValues(new Uint8Array(bytes))),
    },
  });
  const providerCatalog = createProviderCatalog({
    registry,
    providers: providerRepo,
    accounts,
    pool,
  });
  const providerService = createProviderService({
    catalog: providerCatalog,
    providers: providerRepo,
    accounts,
    secrets,
    // The registry's own fetcher shape, because probing and model discovery are
    // the registry's readers — the data plane's response-shaped one would not fit
    // their signature, and a second fetcher for them would be a second place the
    // egress guard has to be remembered.
    fetch: options.providerFetch ?? createOutboundFetcher({ egress }),
    logger,
  });

  const verifications = createVerificationService({
    verifications: verificationRepo,
    probes: probeRunner,
    logger,
  });
  const accountService = createAccountService({ accounts, registry, pool, secrets });

  const jobs = createJobManager({
    jobs: createJobsRepository(persistence.db),
    accounts: accountService,
    accountRows: accounts,
    proxies,
    smsProviders,
    registry,
    // A test that wants a job to run injects its own launcher. The default fails
    // every job loudly rather than spawning a real process from a unit test.
    launcher: options.workerLauncher ?? {
      launch: (workerId) => ({
        id: workerId,
        send: () => undefined,
        kill: () => undefined,
        onMessage: () => undefined,
        onExit: (handler) => {
          handler(1, null);
        },
      }),
    },
    hub,
    secrets,
    logger,
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
  });

  const deps: AppDeps = {
    config,
    meta,
    // No build in a test unless one asks for it: the real `apps/web/dist` may or
    // may not exist depending on whether anyone has run `bun run build`, and a
    // test that changed behaviour based on that would be a test that passes on
    // one machine and fails on another.
    console: options.console ?? NO_CONSOLE,
    logger,
    lifecycle: new Lifecycle(),
    persistence,
    hub,
    abuse: new AbuseGuard({ maxRequests: options.maxRequests ?? 600 }),
    auth: createAuthService({
      credentials: createAuthCredentialRepository(persistence.db),
      sessions: createSessionsRepository(persistence.db),
      authSecret: config.authSecret,
    }),
    apiKeys,
    keyLimiter: new KeyRateLimiter(),
    secrets,
    egress,
    registry,
    providerOauth,
    accounts,
    pool,
    warmup,
    catalog,
    aliases,
    combos,
    mappings,
    planner,
    modelListing: createModelListing({ registry, planner, aliases, combos }),
    requests,
    telemetry,
    usage: createUsageService({ requests, registry }),
    logRing: createLogRing(),
    settings,
    accountService,
    jobs,
    proxies,
    smsProviders,
    proxyProbe,
    smsChecker,
    vccCards,
    filterRules,
    chatSessions,
    studioQueue,
    studioCatalog,
    benchmarkRunner,
    benchmarkCatalog,
    verifications,
    providerCatalog,
    providerService,
    random: options.random ?? ((bytes) => crypto.getRandomValues(new Uint8Array(bytes))),
    fetch: responseFetch,
    tokenSaver: createTokenSaverSettings({ meta }),
  };

  return {
    ...deps,
    meta,
    dataDir,
    close: () => {
      // A device sign-in polls on a timer; left running it would outlive the test.
      providerOauth.stop();
      // And a warmup sweep may be mid-flight. Its probes read accounts, so
      // closing the database underneath one produces `Cannot use a closed
      // database` from a timer nobody is watching — an unhandled rejection that
      // vitest reports as a possible source of false positives. Stopping it first
      // is the same order `main.ts` uses on shutdown, for the same reason.
      warmup.stop();
      persistence.close();
    },
  };
}
