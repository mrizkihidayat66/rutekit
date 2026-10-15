import type {
  RequestLog,
  TimeWindow,
  UsageBreakdownDimension,
  UsageBreakdownResponse,
  UsageSeries,
  UsageSummary,
} from '@contracts';
import type { ProviderRegistry } from '@registry';

import type { RequestsRepository, RequestRow } from '@server/persistence/requests.ts';

import { bucketStarts, windowRange } from './window.ts';

/**
 * The Usage page's read models (FR-12.3, FR-12.4).
 *
 * Three questions over the same rows: what happened in total, how it moved over
 * time, and who it went to. All three are `GROUP BY`s over `requests` (see
 * `persistence/requests.ts` for why there is no rollup table), and this file is
 * what turns those rows into the contract's shapes — naming buckets, filling the
 * gaps, and computing the derived figures the console shows.
 *
 * **Gaps are filled.** A `GROUP BY` returns only the buckets that have rows, so a
 * quiet hour is absent rather than zero. A chart drawn from that list would
 * compress the quiet hours out and make a busy hour look adjacent to another one
 * six hours later — which is the opposite of what a traffic chart is for. So the
 * series is densified across the window, and a bucket with no rows becomes a real
 * zero.
 *
 * The two latency means are passed through as null when nothing was measured,
 * rather than as zero. `avgTtftMs` is null when no turn streamed, and that is a
 * different fact from "the first token arrived instantly".
 */

export interface UsageService {
  summary(window: TimeWindow): UsageSummary;
  series(window: TimeWindow): UsageSeries;
  breakdown(window: TimeWindow, dimension: UsageBreakdownDimension): UsageBreakdownResponse;
}

export interface UsageServiceDeps {
  readonly requests: RequestsRepository;
  readonly registry: ProviderRegistry;
  readonly now?: () => Date;
}

export function createUsageService(deps: UsageServiceDeps): UsageService {
  const now = deps.now ?? ((): Date => new Date());

  function summary(window: TimeWindow): UsageSummary {
    const { from, to } = windowRange(window, now());
    const totals = deps.requests.totals(from, to);

    return {
      window,
      requests: totals.requests,
      // A window with no requests has a success rate of 1, not 0: nothing failed.
      // Reporting 0 would paint a fresh install's dashboard entirely red.
      successRate: totals.requests === 0 ? 1 : (totals.requests - totals.errors) / totals.requests,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cachedInputTokens: totals.cachedInputTokens,
      costUsd: round(totals.costUsd, 6),
      avgTtftMs: totals.avgTtftMs === null ? null : round(totals.avgTtftMs, 1),
      avgLatencyMs: totals.avgLatencyMs === null ? null : round(totals.avgLatencyMs, 1),
      avgTokensPerSecond: tokensPerSecond(from, to),
    };
  }

  /**
   * Mean output tokens per second across completed streams.
   *
   * Derived from the stored totals rather than from a per-turn rate: the row keeps
   * the whole turn's output and its whole latency, and the mean of the ratios is
   * not the ratio of the means — but the ratio of the means is the one an operator
   * can check against the totals the page already shows.
   */
  function tokensPerSecond(from: string, to: string): number | null {
    const totals = deps.requests.totals(from, to);
    if (totals.outputTokens === 0 || totals.avgLatencyMs === null || totals.avgLatencyMs <= 0) {
      return null;
    }
    const seconds = (totals.avgLatencyMs / 1000) * totals.requests;
    if (seconds <= 0) return null;
    return round(totals.outputTokens / seconds, 2);
  }

  function series(window: TimeWindow): UsageSeries {
    const range = windowRange(window, now());
    const rows = deps.requests.series(range.from, range.to, range.bucketSeconds);
    const byBucket = new Map(rows.map((row) => [row.bucket, row]));

    return {
      window,
      points: bucketStarts(range).map((at) => {
        const row = byBucket.get(at);
        return {
          at,
          requests: row?.requests ?? 0,
          inputTokens: row?.inputTokens ?? 0,
          outputTokens: row?.outputTokens ?? 0,
          cachedInputTokens: row?.cachedInputTokens ?? 0,
          costUsd: round(row?.costUsd ?? 0, 6),
          errors: row?.errors ?? 0,
        };
      }),
    };
  }

  function breakdown(
    window: TimeWindow,
    dimension: UsageBreakdownDimension,
  ): UsageBreakdownResponse {
    const { from, to } = windowRange(window, now());
    const rows = deps.requests.breakdown(from, to, dimension);
    const total = rows.reduce((sum, row) => sum + row.requests, 0);

    return {
      window,
      dimension,
      rows: rows.map((row) => ({
        key: row.key,
        label: labelFor(dimension, row.key),
        requests: row.requests,
        tokens: row.tokens,
        costUsd: round(row.costUsd, 6),
        share: total === 0 ? 0 : row.requests / total,
      })),
    };
  }

  /** A breakdown key as something an operator reads. */
  function labelFor(dimension: UsageBreakdownDimension, key: string): string {
    if (key === 'unknown') return 'Unattributed';
    if (dimension === 'provider') return deps.registry.get(key)?.name ?? key;
    if (dimension === 'status') {
      // A status is a number with a name everyone already knows; the number is
      // what the row is grouped by, so the label adds the reason rather than
      // repeating it.
      const status = Number.parseInt(key, 10);
      if (!Number.isFinite(status)) return key;
      return `${String(status)} ${statusName(status)}`;
    }
    return key;
  }

  return { summary, series, breakdown };
}

function statusName(status: number): string {
  if (status < 300) return 'OK';
  if (status === 400) return 'Bad request';
  if (status === 401) return 'Unauthorized';
  if (status === 403) return 'Forbidden';
  if (status === 404) return 'Not found';
  if (status === 429) return 'Rate limited';
  if (status < 500) return 'Client error';
  if (status === 502) return 'Upstream error';
  if (status === 504) return 'Timeout';
  return 'Server error';
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * A stored row as the console's request log.
 *
 * `hasCapture` is an argument rather than a column read: a capture is looked up
 * in a second table and only for the page being shown, so the caller batches it
 * rather than this function asking per row.
 */
export function toRequestLog(row: RequestRow, hasCapture: boolean): RequestLog {
  return {
    id: row.id,
    at: row.at,
    method: row.method,
    path: row.path,
    providerId: row.providerId,
    model: row.model,
    accountId: row.accountId,
    apiKeyId: row.apiKeyId,
    status: row.status,
    errorKind: row.errorKind,
    latencyMs: round(row.latencyMs, 1),
    ttftMs: row.ttftMs === null ? null : round(row.ttftMs, 1),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd,
    streamed: row.streamed,
    hasCapture,
  };
}
