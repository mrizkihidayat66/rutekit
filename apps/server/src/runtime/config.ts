import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * The environment surface, validated once at boot.
 *
 * Every variable in `.env.example` is declared here with the same default, so a
 * misconfiguration is a startup failure with a readable list of what is wrong —
 * rather than a `undefined` that surfaces three layers deep at 3am. Relative
 * paths resolve against the repository root, not the process's working
 * directory, so `bun run --filter` and a direct `bun src/main.ts` behave alike.
 */

export const logLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof logLevelSchema>;

/** 32 bytes, hex-encoded: the AES-256-GCM key for provider credentials (R5.10). */
const encryptionKeySchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)');

/**
 * Networks the egress guard may still reach, comma-separated (C2). Empty means
 * "the public internet only", which is the right default; an entry here is the
 * operator saying a provider really does live on a private network. The shape is
 * not validated by this schema — `EgressPolicy` parses each entry and throws on a
 * bad one, because a typo in a security allowlist has to be loud.
 */
const egressAllowlistSchema = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  );

export const envSchema = z.object({
  RUTEKIT_HOST: z.string().min(1).default('127.0.0.1'),
  RUTEKIT_PORT: z.coerce.number().int().min(1).max(65_535).default(7331),
  /**
   * The origin the operator's browser uses, which is not always this process's
   * own host and port: behind a proxy, and in development where the console is
   * served by Vite and the API is proxied. It is what an OAuth provider is told
   * to redirect to (C3b2), so a wrong value is a sign-in that never returns.
   */
  RUTEKIT_CONSOLE_ORIGIN: z.url().optional(),
  RUTEKIT_DATABASE_URL: z.string().min(1).default('./data/rutekit.sqlite'),
  RUTEKIT_DATA_DIR: z.string().min(1).default('./data'),
  RUTEKIT_ENCRYPTION_KEY: encryptionKeySchema.optional(),
  RUTEKIT_AUTH_SECRET: z.string().min(32).optional(),
  RUTEKIT_EGRESS_ALLOWLIST: egressAllowlistSchema,
  RUTEKIT_NODE_BINARY: z.string().min(1).default('node'),
  RUTEKIT_CAPSOLVER_KEY: z.string().min(1).optional(),
  RUTEKIT_PREVIEW_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  /**
   * The three clocks a proxied stream runs against (CONTRIBUTING §5.6). A
   * provider that accepts a request and then says nothing is the failure mode
   * these exist for: without them the connection is held open forever and the
   * client sees a spinner rather than an error.
   */
  RUTEKIT_STREAM_FIRST_CHUNK_MS: z.coerce.number().int().positive().default(30_000),
  RUTEKIT_STREAM_STALL_MS: z.coerce.number().int().positive().default(60_000),
  RUTEKIT_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  /**
   * How many Studio renders run at once (C10).
   *
   * Two rather than one, because a local renderer's own queue and a hosted
   * endpoint's rate limit are both real ceilings and there is no reason to
   * serialise below them. Not more, because each in-flight render holds a socket
   * and a place in a GPU queue, and a batch of eight opening eight of them at a
   * renderer that runs them one at a time buys nothing but memory.
   */
  RUTEKIT_STUDIO_CONCURRENCY: z.coerce.number().int().positive().max(16).default(2),
  /**
   * How long one render may take before it is failed.
   *
   * A diffusion run is minutes rather than seconds, and a cold model cache can
   * be quiet for a while between nodes — so this is a ceiling on the whole
   * render, not a stall guard. The default is generous because the cost of being
   * wrong is asymmetric: too short fails a render that was about to finish.
   */
  RUTEKIT_STUDIO_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  /**
   * How many benchmark cells run at once (C11).
   *
   * Four, because a benchmark's whole purpose is to compare endpoints under the
   * same conditions and the wall-clock cost of a matrix is real — but not more,
   * because the calls all land on this same instance and a benchmark that
   * saturated the pool would be measuring contention rather than the models.
   */
  RUTEKIT_BENCHMARK_CONCURRENCY: z.coerce.number().int().positive().max(32).default(4),
  /**
   * How long one benchmark run may take before it is killed.
   *
   * A matrix is minutes rather than seconds — twenty-four variants across five
   * targets at a few seconds a cell is a long run — and the ceiling exists so a
   * hung child cannot hold a workspace for ever.
   */
  RUTEKIT_BENCHMARK_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  /**
   * The warmup check-in's two clocks (FR-3.5, FR-3.6). The interval is the same
   * fifteen minutes the console's own fixture sweeps on, so the page an operator
   * watches and the server behind it agree about how often quota moves. The
   * timeout is short on purpose: a probe that has not answered in fifteen seconds
   * is a provider that is down, and holding the sweep open behind it delays every
   * other account's check-in.
   */
  RUTEKIT_WARMUP_INTERVAL_MS: z.coerce.number().int().positive().default(900_000),
  RUTEKIT_WARMUP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  /**
   * What a proxy check asks for, and how long it waits (C7a).
   *
   * The default target is the endpoint served for exactly this purpose: it
   * answers `204` with no body, so the probe measures the round trip rather than
   * the payload. It is overridable because an instance on a restricted network
   * needs to point it somewhere it can actually reach.
   */
  RUTEKIT_PROXY_PROBE_URL: z.string().url().default('https://www.gstatic.com/generate_204'),
  RUTEKIT_PROXY_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
  RUTEKIT_LOG_LEVEL: logLevelSchema.default('info'),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  /**
   * The origin the browser sees, with no trailing slash, so a path can be
   * appended to it directly. Defaults to this process's own host and port, which
   * is right for a direct connection and wrong behind a proxy — hence the
   * override.
   */
  readonly consoleOrigin: string;
  /** Absolute path to the SQLite file, or `:memory:`. */
  readonly databaseUrl: string;
  /** Absolute path to the directory holding generated assets and screenshots. */
  readonly dataDir: string;
  /** Null until the operator generates one; credential storage needs it (PHASE C2). */
  readonly encryptionKey: string | null;
  readonly authSecret: string | null;
  /** Extra CIDRs the egress guard may reach, on top of the public internet (C2). */
  readonly egressAllowlist: readonly string[];
  readonly nodeBinary: string;
  readonly capsolverKey: string | null;
  readonly previewIntervalMs: number;
  /** Longest wait for the provider's first byte before the request is a timeout. */
  readonly streamFirstChunkMs: number;
  /** Longest gap between two chunks of a stream that has already started. */
  readonly streamStallMs: number;
  /** Ceiling on a whole upstream call, streaming or not. */
  readonly upstreamTimeoutMs: number;
  /** At most this many Studio renders run at once; the rest wait in `queued` (C10). */
  readonly studioConcurrency: number;
  /** Ceiling on one Studio render, from submit to the file landing (C10). */
  readonly studioTimeoutMs: number;
  /** At most this many benchmark cells run at once (C11). */
  readonly benchmarkConcurrency: number;
  /** Ceiling on one benchmark run, from submit to the matrix landing (C11). */
  readonly benchmarkTimeoutMs: number;
  /**
   * Where a child process of this server should call back to (C11).
   *
   * A benchmark's thin provider calls this instance's own `/v1`, and it does so
   * from a process on the same machine — so the address has to be one that
   * reaches this process locally, not the one an operator's browser uses.
   * `consoleOrigin` is the wrong value for that: behind a proxy it names a host
   * that may not resolve from inside, and a benchmark that failed because a
   * reverse proxy was down would be a confusing way to learn that.
   */
  readonly loopbackOrigin: string;
  /** How often every account is probed to refresh its state and its quota (FR-3.5). */
  readonly warmupIntervalMs: number;
  /** Ceiling on one warmup probe, so a dead provider cannot hold up the sweep. */
  readonly warmupTimeoutMs: number;
  /** What a proxy check asks for (C7a), and how long it waits. */
  readonly proxyProbeUrl: string;
  readonly proxyProbeTimeoutMs: number;
  readonly logLevel: LogLevel;
  readonly repoRoot: string;
}

/** Raised at boot with the full list of problems, so one restart fixes them all. */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Drop keys that are present but blank. `.env.example` ships every secret as an
 * empty assignment, and `RUTEKIT_ENCRYPTION_KEY=` must mean "not set", not
 * "set to the empty string" — which the schema would otherwise reject.
 */
function withoutEmpty(source: Record<string, string | undefined>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() !== '') kept[key] = value;
  }
  return kept;
}

/**
 * An origin a child process of this server can reach it on (C11).
 *
 * A wildcard bind (`0.0.0.0`, `::`) is listening on loopback as well, so the
 * address to hand a child is `127.0.0.1`. A specific bind is already an address
 * something can dial, so it is used as given — which also covers the case of an
 * operator who bound to a LAN address on purpose.
 */
function loopbackOrigin(host: string, port: number): string {
  const wildcard = host === '0.0.0.0' || host === '::' || host === '[::]' || host === '';
  return `http://${wildcard ? '127.0.0.1' : host}:${String(port)}`;
}

function resolveMaybe(value: string, repoRoot: string): string {
  if (value === ':memory:') return value;
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

/** Pure: the same source always yields the same config, which is what tests need. */
export function parseConfig(
  source: Record<string, string | undefined>,
  repoRoot: string,
): ServerConfig {
  const parsed = envSchema.safeParse(withoutEmpty(source));
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => {
        const name = issue.path.join('.') || '(root)';
        return `${name}: ${issue.message}`;
      }),
    );
  }
  const env = parsed.data;
  return {
    host: env.RUTEKIT_HOST,
    port: env.RUTEKIT_PORT,
    // Trailing slashes are stripped rather than rejected: they are a typo with an
    // obvious intent, and leaving one in produces a redirect URI with `//` in it,
    // which the provider will refuse for a reason nobody can see.
    consoleOrigin: (
      env.RUTEKIT_CONSOLE_ORIGIN ?? `http://${env.RUTEKIT_HOST}:${env.RUTEKIT_PORT}`
    ).replace(/\/+$/, ''),
    databaseUrl: resolveMaybe(env.RUTEKIT_DATABASE_URL, repoRoot),
    dataDir: resolveMaybe(env.RUTEKIT_DATA_DIR, repoRoot),
    encryptionKey: env.RUTEKIT_ENCRYPTION_KEY ?? null,
    authSecret: env.RUTEKIT_AUTH_SECRET ?? null,
    egressAllowlist: env.RUTEKIT_EGRESS_ALLOWLIST,
    nodeBinary: env.RUTEKIT_NODE_BINARY,
    capsolverKey: env.RUTEKIT_CAPSOLVER_KEY ?? null,
    previewIntervalMs: env.RUTEKIT_PREVIEW_INTERVAL_MS,
    streamFirstChunkMs: env.RUTEKIT_STREAM_FIRST_CHUNK_MS,
    streamStallMs: env.RUTEKIT_STREAM_STALL_MS,
    upstreamTimeoutMs: env.RUTEKIT_UPSTREAM_TIMEOUT_MS,
    studioConcurrency: env.RUTEKIT_STUDIO_CONCURRENCY,
    studioTimeoutMs: env.RUTEKIT_STUDIO_TIMEOUT_MS,
    benchmarkConcurrency: env.RUTEKIT_BENCHMARK_CONCURRENCY,
    benchmarkTimeoutMs: env.RUTEKIT_BENCHMARK_TIMEOUT_MS,
    loopbackOrigin: loopbackOrigin(env.RUTEKIT_HOST, env.RUTEKIT_PORT),
    warmupIntervalMs: env.RUTEKIT_WARMUP_INTERVAL_MS,
    warmupTimeoutMs: env.RUTEKIT_WARMUP_TIMEOUT_MS,
    proxyProbeUrl: env.RUTEKIT_PROXY_PROBE_URL,
    proxyProbeTimeoutMs: env.RUTEKIT_PROXY_PROBE_TIMEOUT_MS,
    logLevel: env.RUTEKIT_LOG_LEVEL,
    repoRoot,
  };
}

/**
 * Whether this process is a compiled standalone binary.
 *
 * The marker is the virtual filesystem root `bun build --compile` puts the bundle
 * in, which is the same thing `repoRoot` below reads and the same thing the
 * runtime itself uses to name that root. There is no `Bun.isStandalone` in the
 * runtime this targets.
 */
/**
 * The directory this module was loaded from, or null where the runtime has none.
 *
 * `import.meta.dir` is absent under the test runner, which replaces `import.meta` with
 * an object of its own — the same reason `resolvePromptfooPackage` uses `createRequire`
 * rather than `import.meta.resolve`. Both readers below answer something honest rather
 * than throwing when it is missing.
 */
function moduleDir(): string | null {
  const dir: string | undefined = import.meta.dir;
  return typeof dir === 'string' ? dir : null;
}

export function isCompiledBinary(): boolean {
  return moduleDir()?.includes('~BUN') ?? false;
}

/**
 * What a relative `RUTEKIT_DATABASE_URL` or `RUTEKIT_DATA_DIR` resolves against.
 *
 * Three layouts have to give the right answer, and two of them give the same one:
 *
 * - a compiled binary, whose own path is inside a virtual filesystem;
 * - a bundled npm package, which has no checkout anywhere above it;
 * - the monorepo, where the answer is the repository root so `bun run --filter` and a
 *   direct `bun src/main.ts` behave alike.
 *
 * The first two answer the working directory, because an operator's data belongs where
 * they ran the command — and that is the directory `rutekit init` writes its `.env`
 * into, so the two agree. The monorepo is detected by the one thing a bundle cannot
 * have above it: the server's own source directory.
 */
export function repoRoot(): string {
  const dir = moduleDir();
  if (dir === null || isCompiledBinary()) return process.cwd();
  const monorepo = resolve(dir, '..', '..', '..', '..');
  return existsSync(join(monorepo, 'apps', 'server', 'src')) ? monorepo : process.cwd();
}

export function loadConfig(source: Record<string, string | undefined> = process.env): ServerConfig {
  return parseConfig(source, repoRoot());
}
