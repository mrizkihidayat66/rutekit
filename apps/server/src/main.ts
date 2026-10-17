import { join } from 'node:path';
import { websocket } from 'hono/bun';
import { createIdFactory } from '@shared';
import { createLiveProviderRegistry, createProviderRegistry } from '@registry';
import { providerManifests } from '@registry/providers/index.ts';

import { KeyRateLimiter } from '@server/api-keys/limits.ts';
import { createApiKeyService } from '@server/api-keys/service.ts';
import { buildApp } from '@server/app.ts';
import { createJobManager } from '@server/automation/jobs/manager.ts';
import { createSpawnLauncher, workerEntrypoint } from '@server/automation/launcher.ts';
import { createProxyProbe } from '@server/automation/proxy-probe.ts';
import { createSmsChecker } from '@server/automation/sms-check.ts';
import { createAccountService } from '@server/accounts/service.ts';
import { createAuthService } from '@server/auth/service.ts';
import { AbuseGuard } from '@server/ingress/abuse.ts';
import { createLogger, createLoggerWithRing } from '@server/observability/logger.ts';
import { createLogRing } from '@server/observability/log-ring.ts';
import { createAliasesRepository } from '@server/persistence/aliases.ts';
import { createApiKeysRepository } from '@server/persistence/api-keys.ts';
import { createAppMetaRepository, META_KEYS } from '@server/persistence/app-meta.ts';
import { createAuthCredentialRepository } from '@server/persistence/auth-credential.ts';
import { openPersistence } from '@server/persistence/client.ts';
import { createBenchmarkCatalog } from '@server/benchmark/catalog.ts';
import {
  createPromptfooEngine,
  promptfooEntrypoint,
  resolvePromptfooPackage,
} from '@server/benchmark/engine.ts';
import { createBenchmarkRunner } from '@server/benchmark/runner.ts';
import { createVerificationRepository } from '@server/persistence/verification.ts';
import { createProviderCatalog } from '@server/providers/provider-catalog.ts';
import { createProviderService } from '@server/providers/provider-service.ts';
import { storedProviderManifests } from '@server/providers/stored-manifests.ts';
import { createProbeRunner } from '@server/verification/probe-runner.ts';
import { createVerificationService } from '@server/verification/service.ts';
import { createChatRepository } from '@server/persistence/chat.ts';
import { createBenchmarkRepository } from '@server/persistence/benchmark.ts';
import { createProviderRepository } from '@server/persistence/providers.ts';
import { createCombosRepository } from '@server/persistence/combos.ts';
import { createStudioRepository } from '@server/persistence/studio.ts';
import { createStudioCatalog } from '@server/studio/catalog.ts';
import { createMediaDrivers } from '@server/studio/driver.ts';
import { createComfyUiDriver } from '@server/studio/drivers/comfyui.ts';
import { createStudioQueue } from '@server/studio/queue.ts';
import { globalMediaSocket } from '@server/studio/socket.ts';
import { createAssetStorage } from '@server/studio/storage.ts';
import { createJobsRepository } from '@server/persistence/jobs.ts';
import { createFilterRulesRepository } from '@server/persistence/filter-rules.ts';
import { createMappingsRepository } from '@server/persistence/mappings.ts';
import { currentSchemaVersion, runMigrations } from '@server/persistence/migrate.ts';
import { createProviderAccountsRepository } from '@server/persistence/provider-accounts.ts';
import { createProxiesRepository } from '@server/persistence/proxies.ts';
import { createRequestsRepository } from '@server/persistence/requests.ts';
import { createSessionsRepository } from '@server/persistence/sessions.ts';
import { createSmsProvidersRepository } from '@server/persistence/sms-providers.ts';
import { createVccCardsRepository } from '@server/persistence/vcc.ts';
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
import { RealtimeHub } from '@server/realtime/hub.ts';
import { ConfigError, loadConfig } from '@server/runtime/config.ts';
import type { ServerConfig } from '@server/runtime/config.ts';
import { createGeneralSettings } from '@server/runtime/general-settings.ts';
import { Lifecycle } from '@server/runtime/lifecycle.ts';
import { createShutdown } from '@server/runtime/shutdown.ts';
import { locateConsole } from '@server/routes/console.ts';
import { isCompiledBinary } from '@server/runtime/config.ts';
import { createTokenSaverSettings } from '@server/runtime/token-saver.ts';
import { EgressPolicy } from '@server/security/egress.ts';
import { SecretBox } from '@server/security/secret-box.ts';
import { createTelemetryRecorder } from '@server/telemetry/recorder.ts';
import { createUsageService } from '@server/telemetry/usage.ts';
import type { AppDeps } from '@server/types.ts';

/**
 * The entrypoint: bring the instance up in a fixed order, then keep it up.
 *
 * The order is the whole content of this file, and it is deliberate — the
 * database is migrated before the socket is opened, because a request that
 * arrived before the schema existed would 500 for a reason the operator could
 * not act on. Readiness is announced only once every dependency is in place, so
 * `/readyz` never reports ready for a process that cannot yet serve (NFR-8).
 */

/** How long a drain may take before in-flight work is abandoned. */
const DRAIN_TIMEOUT_MS = 10_000;
const HUB_SWEEP_INTERVAL_MS = 30_000;
const ABUSE_SWEEP_INTERVAL_MS = 60_000;
const KEY_LIMITER_SWEEP_INTERVAL_MS = 60_000;
/** How often a resting account is looked at to see whether its cooldown has passed. */
const POOL_SWEEP_INTERVAL_MS = 60_000;
/**
 * How often expired telemetry and captures are deleted.
 *
 * A minute, not an hour: the retention floor an operator can set is minutes, and
 * a sweep that ran less often than the shortest retention would let rows outlive
 * their window by the difference. The sweep is two indexed deletes, and both
 * return early when there is nothing to remove.
 */
const TELEMETRY_SWEEP_INTERVAL_MS = 60_000;

function loadConfigOrExit(): ServerConfig {
  try {
    return loadConfig();
  } catch (error) {
    // The logger is built before the config is read, precisely so this line can
    // be written: a boot failure that only prints to a console nobody is reading
    // is indistinguishable from a process that never started.
    const logger = createLogger('error');
    if (error instanceof ConfigError) {
      logger.error({ issues: error.issues }, 'invalid configuration; refusing to start');
    } else {
      logger.error({ err: error }, 'failed to load configuration; refusing to start');
    }
    process.exit(1);
  }
}

export function main(): void {
  const config = loadConfigOrExit();
  // The ring is built before the logger, because the logger tees into it: the
  // console log is a copy of what the process says, not a second log.
  const logRing = createLogRing();
  const logger = createLoggerWithRing(config.logLevel, logRing);
  const lifecycle = new Lifecycle();

  const persistence = openPersistence(config);
  const report = runMigrations(persistence.sqlite);
  logger.info(
    {
      applied: report.applied,
      skipped: report.skipped,
      version: currentSchemaVersion(persistence.sqlite),
    },
    'database ready',
  );

  const meta = createAppMetaRepository(persistence.db);
  meta.set(META_KEYS.bootStartedAt, new Date().toISOString());
  meta.set(META_KEYS.schemaVersion, String(currentSchemaVersion(persistence.sqlite)));

  if (config.encryptionKey === null) {
    logger.warn('RUTEKIT_ENCRYPTION_KEY is not set; credential storage stays unavailable');
  }
  if (config.authSecret === null) {
    logger.warn('RUTEKIT_AUTH_SECRET is not set; the password hash uses no pepper');
  }

  const hub = new RealtimeHub(logger);
  const abuse = new AbuseGuard();
  const secrets = config.encryptionKey === null ? null : new SecretBox(config.encryptionKey);
  // A bad CIDR in the allowlist throws here, at boot, rather than at the first
  // outbound request — a security control that fails open is worse than one that
  // refuses to start.
  const egress = new EgressPolicy(config.egressAllowlist);
  const auth = createAuthService({
    credentials: createAuthCredentialRepository(persistence.db),
    sessions: createSessionsRepository(persistence.db),
    authSecret: config.authSecret,
  });
  const apiKeys = createApiKeyService({ apiKeys: createApiKeysRepository(persistence.db) });
  const keyLimiter = new KeyRateLimiter();

  // The catalogue is built here, at boot: `createProviderRegistry` is where a
  // manifest that contradicts itself is caught, and catching it at startup — with
  // the provider named — is the only time that check does any good.
  //
  // A BYOK provider is a row an operator writes while the process runs, so it
  // cannot be part of that boot check — it is merged in on every read instead
  // (C13a). The wrapper is what makes an operator's own endpoint reachable by the
  // router rather than a row only the console can see.
  const providerRepo = createProviderRepository({ db: persistence.db });
  const registry = createLiveProviderRegistry(createProviderRegistry(providerManifests), () =>
    storedProviderManifests(providerRepo),
  );
  const accounts = createProviderAccountsRepository(persistence.db);
  // Every outbound call the provider layer makes goes through the egress guard, so
  // the C2 SSRF control is live for OAuth, discovery and a chat turn alike
  // (outbound.ts). The data plane gets the response-shaped one, because a stream
  // has to be read as it arrives and the registry's `Fetcher` would buffer it.
  const providerFetch = createOutboundFetcher({ egress });
  const responseFetch = createOutboundResponseFetcher({ egress });
  const providerOauth = createProviderOauthService({
    registry,
    accounts,
    secrets,
    // In memory on purpose: a pending sign-in lives for minutes and is worthless
    // after a restart, so a table and a migration would be persistence for a value
    // nothing survives to read (ADR-0008, `pending.ts`).
    pending: createPendingFlows(),
    logger,
    consoleOrigin: config.consoleOrigin,
    fetch: providerFetch,
    env: process.env,
  });

  // The pool is the only thing that chooses among accounts, and it reads the
  // balancing strategy per acquire so a change on the console takes effect on the
  // next turn rather than the next restart.
  const poolStrategy = createPoolStrategySettings({ meta });
  const pool = createPool({
    registry,
    accounts,
    secrets,
    strategy: () => poolStrategy.read(),
    logger,
  });
  const warmup = createWarmup({
    registry,
    accounts,
    secrets,
    fetch: responseFetch,
    config,
    logger,
    // The probe renews a refused credential the same way a turn does, and a
    // signed renewal needs the same ids and primitives a request builder does.
    ids: createIdFactory((bytes) => crypto.getRandomValues(new Uint8Array(bytes))),
    crypto: nodeCrypto,
  });

  // The plan (C5b). Every read is from the database, so there is no cache here to
  // invalidate: a mapping, alias or combo an operator saves on the console is in
  // force on the very next turn.
  const aliases = createAliasesRepository(persistence.db);
  const combos = createCombosRepository(persistence.db);
  const mappings = createMappingsRepository(persistence.db);
  const catalog = createModelCatalog({ registry });

  // Settings (C6). Built before the planner because the planner reads the
  // low-stress switch on every turn, and before the recorder because the
  // recorder reads the capture switch and its TTL.
  const settings = createGeneralSettings({ meta });
  const requests = createRequestsRepository(persistence.db);

  // The automation's two credential pools (C7a). Both probes make a real network
  // call through the same egress guard every other outbound call uses, so neither
  // is a hole in the SSRF control (SEC-4).
  const proxies = createProxiesRepository(persistence.db);
  const smsProviders = createSmsProvidersRepository(persistence.db);

  // The tools (C8): a card pool and the operator's own content rules. The rules
  // are read by the data plane on every turn, so they are a repository on `deps`
  // rather than something only the console route knows about.
  const vccCards = createVccCardsRepository(persistence.db);
  const filterRules = createFilterRulesRepository(persistence.db);

  // The console's own conversations (C9). On `deps` for the reason the filter
  // rules are: the transcript is the server's, and a turn is built from it — the
  // client sends one message, not a conversation.
  const chatSessions = createChatRepository(persistence.db);

  // The Studio (C10): one media driver, one queue, one directory of files.
  //
  // The driver list is the whole of what rutekit can render with, and it is one
  // entry long on purpose — ComfyUI is the only media provider whose API rutekit
  // can actually speak, and a provider with no driver refuses by name rather than
  // failing from a half-written adapter (see `studio/driver.ts`).
  const studioRepo = createStudioRepository({ db: persistence.db });
  const studioStorage = createAssetStorage({ dataDir: config.dataDir });
  const comfyManifest = registry.all().find((manifest) => manifest.id === 'comfyui-local');
  const mediaDrivers = createMediaDrivers({
    drivers:
      comfyManifest === undefined
        ? []
        : [
            createComfyUiDriver({
              manifest: comfyManifest,
              fetch: responseFetch,
              socket: globalMediaSocket,
            }),
          ],
  });
  const studioCatalog = createStudioCatalog({ studio: studioRepo, storage: studioStorage });
  const studioQueue = createStudioQueue({
    studio: studioRepo,
    drivers: mediaDrivers,
    storage: studioStorage,
    registry,
    logger,
    concurrency: config.studioConcurrency,
    timeoutMs: config.studioTimeoutMs,
    publish: (job) => {
      hub.publish('studio', { type: 'studio_progress', generation: job });
    },
  });

  // A render left live by the previous process is recovered, not resumed: the
  // driver that owned it is gone, and its handle means nothing here. Doing this
  // at boot rather than on first read is what stops a dead job from sitting in
  // the queue looking like it is still working.
  const interrupted = studioQueue.recover();
  if (interrupted > 0) {
    logger.warn({ interrupted }, 'studio renders interrupted by the last shutdown');
  }

  // The `studio_cancel` frame, and the first client message the hub has ever had
  // a listener for. The console's Studio page polls and uses the REST route
  // instead; this is for a client that holds a socket, and both end in the same
  // call so the two cannot disagree about what cancelling means.
  hub.onClientMessage((connectionId, message) => {
    if (message.type !== 'studio_cancel') return;
    try {
      studioQueue.cancel(message.generationId);
    } catch (error) {
      // A frame naming a job that is not there is a client out of step with the
      // server, which is worth a log line and not worth a socket error: the
      // console's own read is the authority, and it will show the truth.
      logger.debug({ err: error, connectionId }, 'studio_cancel named no live generation');
    }
  });

  // Benchmarks (C11): promptfoo behind a seam, one workspace per run.
  //
  // The engine is resolved at boot rather than on first use so a missing install
  // is a log line an operator sees once, and the run itself answers with the
  // sentence about installing it. A server that refused to start over a feature
  // nobody had used yet would be the wrong trade.
  const benchmarkRepo = createBenchmarkRepository({ db: persistence.db });
  const promptfooPath = promptfooEntrypoint(resolvePromptfooPackage);
  if (promptfooPath === null) {
    logger.warn('promptfoo is not installed; benchmark runs will fail until it is');
  }
  const benchmarkRunner = createBenchmarkRunner({
    runs: benchmarkRepo,
    apiKeys,
    engine:
      promptfooPath === null
        ? null
        : createPromptfooEngine({
            logger,
            nodeBinary: config.nodeBinary,
            entrypoint: promptfooPath,
            timeoutMs: config.benchmarkTimeoutMs,
          }),
    baseUrl: config.loopbackOrigin,
    workspaceRoot: join(config.dataDir, 'benchmark'),
    providerSource: join(config.repoRoot, 'tools', 'benchmark-provider', 'provider.cjs'),
    maxConcurrency: config.benchmarkConcurrency,
    logger,
  });
  const benchmarkCatalog = createBenchmarkCatalog({ runs: benchmarkRepo });

  // A run left live by the previous process is recovered, not resumed: the
  // promptfoo child it started is gone with the process that spawned it.
  const interruptedRuns = benchmarkRunner.recover();
  if (interruptedRuns > 0) {
    logger.warn({ interruptedRuns }, 'benchmark runs interrupted by the last shutdown');
  }

  // The Providers section (C13a). Built after the pool, because the detail view
  // reports each account's in-flight count from it rather than from the column.
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
    fetch: providerFetch,
    logger,
  });

  // Model verification (C12). The probe runner is the third front door to
  // `callModel`, and the only one that reaches a named endpoint rather than
  // whatever the planner resolved — see `verification/probe-runner.ts` for why
  // that difference matters to a measurement.
  const verificationRepo = createVerificationRepository({ db: persistence.db });
  const probeRunner = createProbeRunner({
    catalog,
    call: {
      pool,
      tokenSaver: createTokenSaverSettings({ meta }),
      filters: () => [],
      fetch: responseFetch,
      config,
      logger,
      // A probe is a turn, so it renews a token the same way one does.
      persistCredential: (accountId, credential) => {
        if (secrets === null) return;
        accounts.setCredential(accountId, secrets.encrypt(credential), new Date().toISOString());
      },
      now: () => Math.floor(Date.now() / 1000),
      ids: createIdFactory((bytes) => crypto.getRandomValues(new Uint8Array(bytes))),
    },
  });
  const verifications = createVerificationService({
    verifications: verificationRepo,
    probes: probeRunner,
    logger,
  });

  const proxyProbe = createProxyProbe({
    egress,
    probeUrl: config.proxyProbeUrl,
    timeoutMs: config.proxyProbeTimeoutMs,
  });
  const smsChecker = createSmsChecker({
    fetch: responseFetch,
    timeoutMs: config.warmupTimeoutMs,
  });

  // The account service is built here rather than inside its route module,
  // because the job manager stores a worker's imported credential through it —
  // the same path an operator's hand-added account goes through, so a job's
  // account lands in the pool with the same state machine and encryption.
  const accountService = createAccountService({
    accounts,
    registry,
    pool,
    secrets,
  });

  // Automation jobs (C7b). One Node worker per job (ADR-0009), launched from the
  // repository the server is running out of.
  const jobManager = createJobManager({
    jobs: createJobsRepository(persistence.db),
    accounts: accountService,
    accountRows: accounts,
    proxies,
    smsProviders,
    registry,
    launcher: createSpawnLauncher({
      logger,
      nodeBinary: config.nodeBinary,
      entrypoint: workerEntrypoint(config.repoRoot),
    }),
    hub,
    secrets,
    logger,
  });
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
    random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
  });

  // Resolved once, and complained about once. A compiled binary with no embedded
  // console serves an API whose root path 404s, and nothing else says so — the
  // operator sees a blank page and has no way to tell a build mistake from a
  // broken instance. That silence is the bug this warns about.
  const console = locateConsole(config.repoRoot);
  if (console.source === 'none' && isCompiledBinary()) {
    logger.warn(
      'no console found: this binary was built without one, so the root path will answer 404. ' +
        'Rebuild with `bun run build`, which embeds apps/web/dist.',
    );
  }

  const deps: AppDeps = {
    config,
    logger,
    lifecycle,
    persistence,
    meta,
    console,
    hub,
    abuse,
    auth,
    apiKeys,
    keyLimiter,
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
    providerCatalog,
    providerService,
    requests,
    telemetry,
    usage: createUsageService({ requests, registry }),
    logRing,
    settings,
    accountService,
    jobs: jobManager,
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
    random: (bytes) => crypto.getRandomValues(new Uint8Array(bytes)),
    fetch: responseFetch,
    tokenSaver: createTokenSaverSettings({ meta }),
  };

  const app = buildApp(deps);
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: app.fetch,
    websocket,
  });

  const hubSweep = setInterval(() => {
    const dropped = hub.sweep();
    if (dropped > 0) logger.debug({ dropped }, 'dropped idle websocket clients');
  }, HUB_SWEEP_INTERVAL_MS);
  const abuseSweep = setInterval(() => abuse.sweep(), ABUSE_SWEEP_INTERVAL_MS);
  // Idle key windows are dropped so a long-running instance does not accumulate
  // a bucket per key it has ever seen.
  const limiterSweep = setInterval(
    () => keyLimiter.sweep(Date.now()),
    KEY_LIMITER_SWEEP_INTERVAL_MS,
  );
  // A cooldown can be as short as a minute, so the sweep runs on that clock: an
  // account parked for a rate limit should rejoin the rotation promptly, not on
  // the warmup interval.
  const poolSweep = setInterval(() => pool.sweep(), POOL_SWEEP_INTERVAL_MS);
  const telemetrySweep = setInterval(() => telemetry.sweep(), TELEMETRY_SWEEP_INTERVAL_MS);
  // The console log's live tail (FR-12.1). The page polls, so this is what makes
  // a second client see the same lines without a second poll — the ring is the
  // source, and the socket is only a way to hear about an append.
  const stopLogPush = logRing.subscribe((entry) => {
    hub.publish('logs', { type: 'log_append', entries: [entry] });
  });
  hubSweep.unref();
  abuseSweep.unref();
  limiterSweep.unref();
  poolSweep.unref();
  telemetrySweep.unref();
  // Started after the socket, so the first sweep cannot land before the console
  // can answer a read of it.
  warmup.start();

  // A job left `running` by a previous process has no worker behind it — no
  // request outlives the process that sent it, and the same is true of a
  // subprocess. Recovery turns those rows into something an operator can act on
  // rather than spinners that never stop, and it runs before readiness so the
  // console never shows a job as live that is not.
  jobManager.recover();

  lifecycle.markReady();
  logger.info(
    { url: `http://${config.host}:${String(server.port)}`, database: config.databaseUrl },
    'rutekit listening',
  );

  // The order lives in `runtime/shutdown.ts`, where a test can hold it — see that
  // file for why each step is where it is. This is only the wiring: the process's
  // own intervals, the objects built above, and the two ways out.
  const shutdown = createShutdown({
    logger,
    lifecycle,
    intervals: [
      { name: 'hub-sweep', handle: hubSweep },
      { name: 'abuse-sweep', handle: abuseSweep },
      { name: 'limiter-sweep', handle: limiterSweep },
      { name: 'pool-sweep', handle: poolSweep },
      { name: 'telemetry-sweep', handle: telemetrySweep },
    ],
    logPush: { stop: stopLogPush },
    warmup,
    jobs: jobManager,
    hub,
    server,
    providerOauth,
    persistence,
    drainTimeoutMs: DRAIN_TIMEOUT_MS,
    exit: (code) => process.exit(code),
  });

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled rejection');
  });
  process.on('uncaughtException', (error) => {
    // The process is in an unknown state after this; drain rather than continue.
    logger.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

// Only when this file *is* the program. The CLI imports `main` to start the
// server in-process, and an unguarded call at the bottom would boot the server
// the moment the import was resolved — including for `rutekit --help`.
if (import.meta.main) main();
