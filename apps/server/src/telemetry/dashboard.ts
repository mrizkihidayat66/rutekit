import { statSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import type { Logger } from 'pino';
import type {
  CreditPool,
  Dashboard,
  EndpointStatus,
  SystemHealthTile,
  SystemStatus,
  UsagePoint,
} from '@contracts';

import type { ApiKeyService } from '@server/api-keys/service.ts';
import type { ProviderAccountsRepository } from '@server/persistence/provider-accounts.ts';
import type { RequestsRepository } from '@server/persistence/requests.ts';
import type { Pool } from '@server/pool/pool.ts';
import type { ProviderRegistry } from '@registry';
import type { Lifecycle } from '@server/runtime/lifecycle.ts';
import type { GeneralSettingsStore } from '@server/runtime/general-settings.ts';
import { SERVER_VERSION } from '@server/version.ts';

import { toRequestLog } from './usage.ts';
import { windowRange } from './window.ts';

/**
 * The Dashboard's read model (FR-12.3, FR-12.4).
 *
 * One request that answers every card on the page. The alternative — a route per
 * card — would make the dashboard's first paint a fan-out of six requests, each
 * of which the shell would have to coordinate, and the tiles are all drawn from
 * the same few facts: the pool's counts, the process's own resources, and the
 * request table over the last day.
 *
 * **Resources come from the process, not from a metrics store.** A single-user
 * instance is one process on one box, so `process.memoryUsage()`, `os.freemem()`
 * and the SQLite file's own size are the truth rather than an estimate of it.
 * Nothing here is sampled or averaged over time, because there is no history to
 * average and a dashboard that invented one would be lying about what it knows.
 */

/** Surfaces the endpoint card reports on, in the order the console lists them. */
const SURFACES = [
  { surface: 'chat/completions', path: '/v1/chat/completions' },
  { surface: 'messages', path: '/v1/messages' },
  { surface: 'responses', path: '/v1/responses' },
  { surface: 'completions', path: '/v1/completions' },
  { surface: 'models', path: '/v1/models' },
] as const;

/** The dashboard's traffic chart is always a day, whatever the usage page is set to. */
const TRAFFIC_WINDOW = '24h';

export interface DashboardService {
  read(): Dashboard;
}

export interface DashboardDeps {
  readonly registry: ProviderRegistry;
  readonly accounts: ProviderAccountsRepository;
  readonly pool: Pool;
  readonly apiKeys: ApiKeyService;
  readonly requests: RequestsRepository;
  readonly lifecycle: Lifecycle;
  readonly settings: GeneralSettingsStore;
  readonly logger: Logger;
  /** Whether SQLite is answering, for the database tile. */
  readonly ping: () => boolean;
  /** Open websocket connections, for the real-time tile. */
  readonly connections: () => number;
  /** The database file, for the disk tile. Null on an in-memory instance. */
  readonly databasePath: string | null;
  readonly now?: () => Date;
}

export function createDashboardService(deps: DashboardDeps): DashboardService {
  const now = deps.now ?? ((): Date => new Date());

  return {
    read(): Dashboard {
      const at = now();
      const settings = deps.settings.read();
      const range = windowRange(TRAFFIC_WINDOW, at);
      const providers = providerCounts(deps);
      const accounts = accountCounts(deps);
      const endpoints = endpointStatuses(deps, range);

      return {
        status: systemStatus(deps, at, settings.lowStressMode, endpoints),
        traffic: traffic(deps, range),
        providers,
        accounts,
        recentErrors: deps.requests
          .recentErrors(5)
          .map((row) => toRequestLog(row, false)),
        // No provider in the catalogue publishes a refillable credit pool and
        // there is no column that could hold one, so this is empty rather than
        // invented. It fills in when a provider with that model arrives.
        quotaPools: [] satisfies CreditPool[],
        apiKeys: deps.apiKeys.list({ q: '', state: null, sort: null, direction: 'desc', limit: 200, cursor: null }).items,
      };
    },
  };
}

function providerCounts(deps: DashboardDeps): Dashboard['providers'] {
  let ready = 0;
  let needsAuth = 0;
  let error = 0;
  let disabled = 0;

  for (const manifest of deps.registry.all()) {
    const accounts = deps.accounts.listByProvider(manifest.id);
    if (accounts.length === 0) {
      // A provider with no credential is one rutekit cannot reach, which is what
      // "needs auth" means to the operator looking at the tile.
      needsAuth += 1;
      continue;
    }
    if (accounts.some((account) => account.state === 'active')) ready += 1;
    else if (accounts.some((account) => account.state === 'error' || account.state === 'banned')) {
      error += 1;
    } else disabled += 1;
  }

  return {
    total: deps.registry.all().length,
    ready,
    needsAuth,
    error,
    disabled,
  };
}

function accountCounts(deps: DashboardDeps): Dashboard['accounts'] {
  const rows = deps.accounts.listAll();
  return {
    total: rows.length,
    active: rows.filter((row) => row.state === 'active').length,
    // The live count from the pool, not the mirrored column: the column is one
    // write behind by construction (ADR-0020).
    inFlight: rows.reduce((sum, row) => sum + deps.pool.inFlight(row.id), 0),
    cooldown: rows.filter((row) => row.state === 'rate_limited' || row.state === 'exhausted').length,
    unhealthy: rows.filter((row) => row.state === 'error' || row.state === 'banned').length,
  };
}

function endpointStatuses(
  deps: DashboardDeps,
  range: { from: string; to: string },
): EndpointStatus[] {
  const stats = new Map(deps.requests.endpointStats(range.from, range.to).map((row) => [row.path, row]));

  return SURFACES.map(({ surface, path }) => {
    const row = stats.get(path);
    return {
      surface,
      enabled: true,
      requestsLastHour: row?.requests ?? 0,
      errorsLastHour: row?.errors ?? 0,
      avgLatencyMs: row?.avgLatencyMs === null || row?.avgLatencyMs === undefined
        ? null
        : Math.round(row.avgLatencyMs * 10) / 10,
    };
  });
}

function traffic(deps: DashboardDeps, range: { from: string; to: string; bucketSeconds: number }): UsagePoint[] {
  return deps.requests.series(range.from, range.to, range.bucketSeconds).map((row) => ({
    at: row.bucket,
    requests: row.requests,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedInputTokens: row.cachedInputTokens,
    costUsd: row.costUsd,
    errors: row.errors,
  }));
}

function systemStatus(
  deps: DashboardDeps,
  at: Date,
  lowStressMode: boolean,
  endpoints: readonly EndpointStatus[],
): SystemStatus {
  const memory = process.memoryUsage();

  return {
    version: SERVER_VERSION,
    startedAt: new Date(deps.lifecycle.startedAtMs).toISOString(),
    serverTimeUtc: at.toISOString(),
    resources: {
      // Heap in use, not resident set: the RSS includes the runtime's own
      // mappings, and an operator watching a memory tile is watching the part
      // that grows with traffic.
      memoryUsedBytes: memory.heapUsed,
      memoryTotalBytes: totalmem() - freemem(),
      cpuPercent: cpuPercent(),
      uptimeSeconds: deps.lifecycle.uptimeSeconds,
      diskUsedBytes: diskUsage(deps),
      nodeVersion: process.version,
      bunVersion: Bun.version,
      platform: process.platform,
    },
    health: healthTiles(deps),
    endpoints: [...endpoints],
    lowStressMode,
  };
}

function healthTiles(deps: DashboardDeps): SystemHealthTile[] {
  const databaseUp = deps.ping();
  const routable = deps.accounts
    .listAll()
    .filter((row) => row.state === 'active').length;

  return [
    {
      id: 'database',
      label: 'Database',
      state: databaseUp ? 'healthy' : 'down',
      value: databaseUp ? 'Reachable' : 'Unreachable',
      detail: null,
    },
    {
      id: 'pool',
      label: 'Account pool',
      // No routable account is a degraded instance, not a broken one: rutekit is
      // running fine and simply has nothing to send a turn as.
      state: routable > 0 ? 'healthy' : 'degraded',
      value: `${String(routable)} ready`,
      detail: null,
    },
    {
      id: 'websocket',
      label: 'Real-time',
      state: 'healthy',
      value: `${String(deps.connections())} clients`,
      detail: null,
    },
  ];
}

/**
 * CPU load as a percentage of one core, averaged over the process's life.
 *
 * `process.cpuUsage()` is cumulative, so dividing by uptime gives a mean rather
 * than an instantaneous reading. That is the honest figure available without a
 * sampler: `os.loadavg()` returns zeros on Windows, and a tile that showed a
 * fabricated instantaneous number would be worse than one showing a true average.
 */
function cpuPercent(): number {
  const load = process.cpuUsage();
  const seconds = Math.max(1, process.uptime());
  const cores = Math.max(1, cpus().length);
  const percent = ((load.user + load.system) / 1_000_000 / seconds / cores) * 100;
  return Math.min(100, Math.round(percent * 10) / 10);
}

/** The database file's size on disk, or 0 on an in-memory instance. */
function diskUsage(deps: DashboardDeps): number {
  if (deps.databasePath === null) return 0;
  try {
    return statSync(deps.databasePath).size;
  } catch {
    return 0;
  }
}
