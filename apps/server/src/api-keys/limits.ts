/**
 * The two per-key ceilings: tokens per second (FR-6.4) and requests per minute.
 *
 * Counters live in memory, not in SQLite. A rate limit is a property of *this*
 * process's traffic — a restart clearing it is correct, and a database write per
 * request to count requests would cost more than the limit saves. The budget
 * ceilings are a different thing and stay in the row, because those must survive
 * a restart.
 *
 * Windows are fixed rather than sliding: a caller can burst to twice the limit
 * across a boundary, and in exchange the check is two integers and a comparison
 * with no per-request bookkeeping. For a self-hosted gateway whose ceilings exist
 * to stop a runaway script, that is the right trade — a sliding window would be
 * precision nobody asked for.
 */

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
/**
 * A key with no traffic for this long is dropped from the map. Without it the
 * map would grow with every key ever seen, including deleted ones.
 */
const IDLE_MS = 10 * MINUTE_MS;

export type LimitReason = 'tps' | 'rate_limit';

export interface LimitDecision {
  readonly allowed: boolean;
  readonly reason: LimitReason | null;
  /** Whole seconds to wait; at least 1, so a client never retries within the window. */
  readonly retryAfterSeconds: number;
}

export interface KeyLimits {
  readonly tpsLimit: number | null;
  readonly rateLimitPerMinute: number | null;
}

interface Window {
  startMs: number;
  count: number;
}

const ALLOWED: LimitDecision = { allowed: true, reason: null, retryAfterSeconds: 0 };

function secondsUntil(endMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((endMs - nowMs) / 1_000));
}

export class KeyRateLimiter {
  readonly #byKey = new Map<string, { second: Window; minute: Window; seenMs: number }>();

  /**
   * Count one request against a key, or refuse it. A refusal does not consume a
   * slot — the caller did not get served, so it should not pay for the attempt.
   */
  check(keyId: string, limits: KeyLimits, nowMs: number): LimitDecision {
    const { tpsLimit, rateLimitPerMinute } = limits;
    if (tpsLimit === null && rateLimitPerMinute === null) return ALLOWED;

    const entry = this.#entry(keyId, nowMs);
    entry.seenMs = nowMs;

    if (rateLimitPerMinute !== null && entry.minute.count >= rateLimitPerMinute) {
      return {
        allowed: false,
        reason: 'rate_limit',
        retryAfterSeconds: secondsUntil(entry.minute.startMs + MINUTE_MS, nowMs),
      };
    }
    if (tpsLimit !== null && entry.second.count >= tpsLimit) {
      return {
        allowed: false,
        reason: 'tps',
        retryAfterSeconds: secondsUntil(entry.second.startMs + SECOND_MS, nowMs),
      };
    }

    entry.minute.count += 1;
    entry.second.count += 1;
    return ALLOWED;
  }

  /** Drop a key's counters, so a revoked-then-recreated id starts clean. */
  forget(keyId: string): void {
    this.#byKey.delete(keyId);
  }

  /** Drop every key that has been idle. Returns how many went. */
  sweep(nowMs: number): number {
    let dropped = 0;
    for (const [keyId, entry] of this.#byKey) {
      if (nowMs - entry.seenMs >= IDLE_MS) {
        this.#byKey.delete(keyId);
        dropped += 1;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.#byKey.size;
  }

  #entry(keyId: string, nowMs: number): { second: Window; minute: Window; seenMs: number } {
    let entry = this.#byKey.get(keyId);
    if (entry === undefined) {
      entry = {
        second: { startMs: nowMs, count: 0 },
        minute: { startMs: nowMs, count: 0 },
        seenMs: nowMs,
      };
      this.#byKey.set(keyId, entry);
      return entry;
    }
    if (nowMs - entry.second.startMs >= SECOND_MS) {
      entry.second = { startMs: nowMs, count: 0 };
    }
    if (nowMs - entry.minute.startMs >= MINUTE_MS) {
      entry.minute = { startMs: nowMs, count: 0 };
    }
    return entry;
  }
}
