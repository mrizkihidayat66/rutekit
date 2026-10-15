import type { Logger } from 'pino';
import type { MiddlewareHandler } from 'hono';

import { AppError } from '@server/errors.ts';
import type { AppEnv } from '@server/types.ts';

/**
 * A per-address request ceiling.
 *
 * Deliberately a blunt instrument: a fixed window per address, counted before
 * any route is matched, so a flood of requests to paths that do not exist is
 * counted too (CONTRIBUTING §5.2 — this runs on the composition root's request
 * hook, not as a route-scoped stage). Per-key quota, per-model rate limits and
 * budget enforcement are a different, later concern (FR-6.4); this one only
 * stops a single source from making the instance unusable for everyone else.
 */

export interface AbuseGuardOptions {
  /** Requests allowed per address per window. */
  readonly maxRequests?: number;
  readonly windowMs?: number;
  /** Injectable clock, so a test can advance time without waiting. */
  readonly now?: () => number;
}

export interface AbuseVerdict {
  readonly allowed: boolean;
  /** Seconds until the oldest hit leaves the window; 0 when allowed. */
  readonly retryAfterSeconds: number;
}

const DEFAULT_MAX_REQUESTS = 600;
const DEFAULT_WINDOW_MS = 60_000;

export class AbuseGuard {
  readonly #maxRequests: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #hits = new Map<string, number[]>();

  constructor(options: AbuseGuardOptions = {}) {
    this.#maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.#now = options.now ?? Date.now;
  }

  /** Number of addresses currently being tracked. */
  get trackedAddresses(): number {
    return this.#hits.size;
  }

  check(address: string): AbuseVerdict {
    const now = this.#now();
    const cutoff = now - this.#windowMs;
    const recent = (this.#hits.get(address) ?? []).filter((at) => at > cutoff);

    if (recent.length >= this.#maxRequests) {
      this.#hits.set(address, recent);
      const oldest = recent[0] ?? now;
      const remainingMs = oldest + this.#windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
    }

    recent.push(now);
    this.#hits.set(address, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Forget addresses with nothing left in the window. Driven by a timer. */
  sweep(): void {
    const cutoff = this.#now() - this.#windowMs;
    for (const [address, hits] of this.#hits) {
      const recent = hits.filter((at) => at > cutoff);
      if (recent.length === 0) this.#hits.delete(address);
      else this.#hits.set(address, recent);
    }
  }

  reset(): void {
    this.#hits.clear();
  }
}

export interface AbuseGuardMiddlewareOptions {
  /**
   * Paths the counter ignores. The two probes are here: a supervisor polling
   * them must never be throttled into believing the instance is unhealthy, and
   * a throttled `/readyz` would read as "not ready" — the opposite of true.
   */
  readonly exemptPaths?: readonly string[];
}

const DEFAULT_EXEMPT_PATHS = ['/healthz', '/readyz'];

export function abuseGuard(
  guard: AbuseGuard,
  logger: Logger,
  options: AbuseGuardMiddlewareOptions = {},
): MiddlewareHandler<AppEnv> {
  const exempt = new Set(options.exemptPaths ?? DEFAULT_EXEMPT_PATHS);

  return async (c, next) => {
    if (exempt.has(c.req.path)) {
      await next();
      return;
    }

    let verdict: AbuseVerdict;
    try {
      verdict = guard.check(c.get('clientIp'));
    } catch (error) {
      // Fail-open (R5.5). A counter that has broken is a degraded protection,
      // not a reason to refuse every request the instance receives.
      logger.warn({ err: error }, 'abuse guard failed; request allowed');
      verdict = { allowed: true, retryAfterSeconds: 0 };
    }

    if (!verdict.allowed) {
      c.header('retry-after', String(verdict.retryAfterSeconds));
      throw AppError.rateLimit(verdict.retryAfterSeconds);
    }
    await next();
  };
}
