import type {
  AuthStatus,
  BackupArchive,
  BackupManifest,
  CreditPool,
  Customization,
  EndpointStatus,
  GeneralSettings,
  RestoreResult,
  SystemHealthTile,
  SystemStatus,
} from '@contracts';

import { hoursAgo, hoursFromNow, minutesAgo } from '../clock.ts';
import type { Rng } from '../random.ts';

/**
 * System fixtures cover the three pages that are *about* the instance rather
 * than about traffic: Customization (appearance), Settings (behaviour) and the
 * dashboard's own status tiles. They are mostly static by nature — the numbers
 * a real instance reports are boring and stable — so the only thing worth
 * varying here is the health state of a tile or two, which is what makes the
 * dashboard's warning colouring visible at all.
 */

export function buildCustomization(): Customization {
  return {
    theme: 'system',
    brandingIconUrl: null,
    backgroundKind: 'none',
    backgroundUrl: null,
    backgroundOpacity: 0.5,
    backgroundBlurPx: 0,
    glassEnabled: true,
    glassDepth: 2,
    ambientGlow: true,
  };
}

export function buildGeneralSettings(): GeneralSettings {
  return {
    instanceName: 'rutekit',
    lowStressMode: false,
    telemetryRetentionMinutes: 10_080,
    payloadCaptureEnabled: true,
    payloadCaptureTtlMinutes: 1_440,
    defaultProviderId: 'openai',
    logLevel: 'info',
  };
}

export function buildAuthStatus(): AuthStatus {
  return {
    configured: true,
    authenticated: true,
    sessionExpiresAt: hoursFromNow(12),
  };
}

export function buildBackupManifest(tableCounts: Record<string, number>): BackupManifest {
  return {
    version: '0.1.0',
    createdAt: minutesAgo(90),
    includesCredentials: false,
    tableCounts,
  };
}

/**
 * The archive an export produces.
 *
 * Built from the same `tableCounts` the manifest reports, so the two cannot
 * disagree about what the instance holds — and with one throwaway row per table,
 * because the archive's shape is what the console validates. The rows are not the
 * mock database's own: this file's job is to be a well-formed archive, and a
 * restore in the mock does not read the values back.
 *
 * `auth_credential` and `sessions` are absent and named in `omitted`, exactly as
 * the real export leaves them.
 */
export function buildBackupArchive(
  tableCounts: Record<string, number>,
  includeCredentials: boolean,
): BackupArchive {
  return {
    format: 1,
    schemaVersion: 15,
    version: '0.1.0',
    createdAt: minutesAgo(0),
    includesCredentials: includeCredentials,
    tables: Object.fromEntries(
      Object.entries(tableCounts).map(([table, count]) => [
        table,
        Array.from({ length: count }, (_unused, index) => ({ id: `${table}_${String(index)}` })),
      ]),
    ),
    omitted: [
      {
        table: 'auth_credential',
        reason: 'The instance password. A restore replaces the configuration, not who may open it.',
      },
      {
        table: 'sessions',
        reason: 'Live console logins. Restoring them would resurrect sessions an operator ended.',
      },
      {
        table: 'app_meta',
        reason:
          'Boot metadata and the settings records, which are restored through their own paths.',
      },
    ],
  };
}

/**
 * What a restore reports back.
 *
 * Every table the archive named was replaced and nothing was refused, which is
 * the ordinary case — the console renders the refusals it is given, and a mock
 * that always produced a clean run is the one that lets a broken refusal branch
 * ship.
 */
export function buildRestoreResult(archive: BackupArchive): RestoreResult {
  const tables = Object.keys(archive.tables);
  return {
    ok: true,
    tables: tables.length,
    rows: Object.values(archive.tables).reduce((total, rows) => total + rows.length, 0),
    untouched: [],
    skipped: [],
  };
}

/** Pools that refill on a schedule — the dashboard draws these with a countdown. */
export function buildCreditPools(rng: Rng): CreditPool[] {
  return [
    {
      providerId: 'google-ai-studio',
      label: 'Free tier, per minute',
      totalCredits: 15,
      usedCredits: 6,
      resetInSeconds: rng.int(8, 52),
      resetAt: null,
      currency: null,
    },
    {
      providerId: 'groq',
      label: 'Free tier, per day',
      totalCredits: 14_400,
      usedCredits: 9_812,
      resetInSeconds: rng.int(2_000, 40_000),
      resetAt: null,
      currency: null,
    },
    {
      providerId: 'openrouter',
      label: 'Credit balance',
      totalCredits: 40,
      usedCredits: 27.42,
      resetInSeconds: null,
      resetAt: null,
      currency: 'USD',
    },
    {
      providerId: 'cerebras',
      label: 'Free tier, per day',
      totalCredits: 1_000_000,
      usedCredits: 412_889,
      resetInSeconds: rng.int(4_000, 50_000),
      resetAt: null,
      currency: null,
    },
    {
      providerId: 'mistral',
      label: 'Trial credits',
      totalCredits: 25,
      usedCredits: 24.1,
      resetInSeconds: null,
      resetAt: null,
      currency: 'EUR',
    },
  ];
}

function resources(rng: Rng): SystemStatus['resources'] {
  const total = 16 * 1024 ** 3;
  return {
    memoryUsedBytes: Math.floor(total * rng.float(0.31, 0.58)),
    memoryTotalBytes: total,
    cpuPercent: rng.round(rng.float(3.2, 41.7), 1),
    uptimeSeconds: rng.int(3_600 * 6, 3_600 * 24 * 40),
    diskUsedBytes: rng.int(200 * 1024 ** 2, 6 * 1024 ** 3),
    nodeVersion: 'v22.11.0',
    bunVersion: '1.4.2',
    platform: 'linux-x64',
  };
}

function health(rng: Rng): SystemHealthTile[] {
  const dbSlow = rng.bool(0.15);
  const poolDegraded = rng.bool(0.35);
  const automationIdle = rng.bool(0.4);
  return [
    {
      id: 'db',
      label: 'Database',
      state: dbSlow ? 'degraded' : 'healthy',
      value: dbSlow ? '84 ms' : '12 ms',
      detail: 'SQLite, WAL mode.',
    },
    {
      id: 'pool',
      label: 'Provider pool',
      state: poolDegraded ? 'degraded' : 'healthy',
      value: poolDegraded ? '5 / 8 healthy' : '7 / 8 healthy',
      detail: poolDegraded ? 'Two accounts in cooldown.' : null,
    },
    {
      id: 'automation',
      label: 'Automation workers',
      state: automationIdle ? 'unknown' : 'healthy',
      value: automationIdle ? 'idle' : '2 / 4 busy',
      detail: automationIdle ? 'No job running.' : null,
    },
    {
      id: 'proxies',
      label: 'Proxy pool',
      state: 'healthy',
      value: '18 / 26 healthy',
      detail: '4 dead, 4 untested.',
    },
    {
      id: 'disk',
      label: 'Disk',
      state: 'healthy',
      value: '3.1 GB used',
      detail: 'Assets and the SQLite file.',
    },
  ];
}

function endpoints(rng: Rng): EndpointStatus[] {
  const plan: readonly {
    surface: EndpointStatus['surface'];
    enabled: boolean;
    requests: number;
  }[] = [
    { surface: 'chat/completions', enabled: true, requests: 412 },
    { surface: 'messages', enabled: true, requests: 96 },
    { surface: 'responses', enabled: true, requests: 51 },
    { surface: 'completions', enabled: false, requests: 0 },
    { surface: 'models', enabled: true, requests: 34 },
  ];
  return plan.map((entry) => ({
    surface: entry.surface,
    enabled: entry.enabled,
    requestsLastHour: entry.requests,
    errorsLastHour:
      entry.requests === 0 ? 0 : rng.int(0, Math.max(1, Math.floor(entry.requests * 0.04))),
    avgLatencyMs: entry.requests === 0 ? null : rng.int(180, 2_600),
  }));
}

export function buildSystemStatus(rng: Rng, options: { lowStressMode: boolean }): SystemStatus {
  return {
    version: '0.1.0',
    startedAt: hoursAgo(rng.int(6, 900)),
    serverTimeUtc: minutesAgo(0),
    resources: resources(rng),
    health: health(rng),
    endpoints: endpoints(rng),
    lowStressMode: options.lowStressMode,
  };
}
