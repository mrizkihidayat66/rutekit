import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';

import type { Db } from './client.ts';
import { requestCaptures, requests } from './schema.ts';

/**
 * Per-request telemetry (C6, FR-12.2–12.4).
 *
 * The insert is one row per turn and the reads are aggregations over a time
 * window, so the two halves look different on purpose. `record` is a single
 * insert on the hot path; everything else is a read the console makes when
 * somebody is looking at a page.
 *
 * **Aggregation happens in SQL, at read time.** The alternative — a rollup table
 * written as each turn finishes — would make every read a one-row `select` and
 * every write a second write, and the two could then disagree: a turn whose
 * rollup update failed would be counted in the request table and missing from
 * the chart, with nothing to reconcile them. Counting the raw rows means the
 * chart cannot say anything the table does not, and the retention sweep bounds
 * how much there is to count.
 *
 * `sum` over a column that is null for some rows ignores those rows, which is
 * what the nulls are for: a turn whose provider reported no usage must not pull
 * a token average toward zero.
 */

export type RequestRow = typeof requests.$inferSelect;
export type RequestInsert = typeof requests.$inferInsert;
export type CaptureRow = typeof requestCaptures.$inferSelect;
export type CaptureInsert = typeof requestCaptures.$inferInsert;

/** One aggregation bucket, as SQL returns it — counts arrive as strings. */
export interface UsageBucketRow {
  readonly bucket: string;
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly costUsd: number;
}

/** Token Saver totals over a window (C14). Only turns the pipeline actually ran on. */
export interface SavingsTotalsRow {
  readonly requests: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly tokensSaved: number;
}

/** One stage's share of the savings, summed over the window. */
export interface StageSavingsRow {
  readonly stageId: string;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly tokensSaved: number;
}

/** One point of the savings trend. */
export interface SavingsPointRow {
  readonly bucket: string;
  readonly tokensSaved: number;
}

/** The totals over a window, plus the two latency means. */
export interface UsageTotalsRow {
  readonly requests: number;
  readonly errors: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly costUsd: number;
  readonly avgTtftMs: number | null;
  readonly avgLatencyMs: number | null;
}

/** One row of a breakdown, grouped by whichever column was asked for. */
export interface BreakdownRow {
  readonly key: string;
  readonly requests: number;
  readonly tokens: number;
  readonly costUsd: number;
}

/** Per-surface counters for the dashboard's endpoint card. */
export interface EndpointStatsRow {
  readonly path: string;
  readonly requests: number;
  readonly errors: number;
  readonly avgLatencyMs: number | null;
}

export interface RequestsRepository {
  record(insert: RequestInsert): void;
  findById(id: string): RequestRow | null;
  /** The per-request table's page, newest first, with the console's filters. */
  listBetween(
    from: string,
    to: string,
    filters: RequestFilters,
    limit: number,
    offset?: number,
  ): RequestRow[];
  countBetween(from: string, to: string, filters: RequestFilters): number;
  /** Totals over the window, for the usage summary. */
  totals(from: string, to: string): UsageTotalsRow;
  /** Hourly buckets over the window, for the traffic and usage charts. */
  series(from: string, to: string, bucketSeconds: number): UsageBucketRow[];
  /** Grouped by a named column. `column` is chosen from a fixed set by the caller. */
  breakdown(from: string, to: string, dimension: BreakdownDimension): BreakdownRow[];
  /** Per-surface counters over the window, for the dashboard's endpoint card. */
  endpointStats(from: string, to: string): EndpointStatsRow[];
  /**
   * Token Saver totals over the window, counting only turns the pipeline ran on
   * (C14). A turn with no savings record is absent rather than zero, which is
   * what keeps `requestsProcessed` a count of compressed turns.
   */
  savingsTotals(from: string, to: string): SavingsTotalsRow;
  /** Per-stage savings over the window, unnesting the stored JSON. */
  savingsByStage(from: string, to: string): StageSavingsRow[];
  /** The savings trend, bucketed the same way the usage series is. */
  savingsSeries(from: string, to: string, bucketSeconds: number): SavingsPointRow[];
  /** Recent failures, for the dashboard's "what broke" panel. */
  recentErrors(limit: number): RequestRow[];
  /** Delete rows older than `before`. Returns how many went. */
  deleteOlderThan(before: string): number;
  /** Capture rows for one request, oldest stage first. */
  capturesFor(requestId: string, now: string): CaptureRow[];
  saveCapture(insert: CaptureInsert): void;
  /** Delete captures whose TTL has passed. Returns how many went. */
  deleteExpiredCaptures(now: string): number;
  /** Whether a request still has a live capture, for the table's `hasCapture`. */
  capturedRequestIds(requestIds: readonly string[], now: string): Set<string>;
}

export interface RequestFilters {
  readonly providerId?: string | null;
  readonly model?: string | null;
  readonly apiKeyId?: string | null;
  readonly outcome?: 'all' | 'errors' | 'success';
}

export type BreakdownDimension = 'provider' | 'model' | 'account' | 'apiKey' | 'status';

/**
 * The column each breakdown dimension groups by.
 *
 * A map rather than string interpolation into SQL: the dimension arrives from a
 * query string, and a name that reached the query builder unvalidated would be
 * an injection. Every value here is a column object, so nothing a caller sends
 * is ever parsed as SQL.
 */
const BREAKDOWN_COLUMN = {
  provider: requests.providerId,
  model: requests.model,
  account: requests.accountId,
  apiKey: requests.apiKeyId,
  status: sql<string>`cast(${requests.status} as text)`,
} as const;

export function createRequestsRepository(db: Db): RequestsRepository {
  /** The `where` every windowed read shares. */
  function windowWhere(from: string, to: string, filters: RequestFilters = {}) {
    const clauses = [gte(requests.at, from), lt(requests.at, to)];
    if (filters.providerId != null) clauses.push(eq(requests.providerId, filters.providerId));
    if (filters.model != null) clauses.push(eq(requests.model, filters.model));
    if (filters.apiKeyId != null) clauses.push(eq(requests.apiKeyId, filters.apiKeyId));
    if (filters.outcome === 'errors') clauses.push(gte(requests.status, 400));
    if (filters.outcome === 'success') clauses.push(lt(requests.status, 400));
    return and(...clauses);
  }

  return {
    record(insert: RequestInsert): void {
      db.insert(requests).values(insert).run();
    },

    findById(id: string): RequestRow | null {
      return db.select().from(requests).where(eq(requests.id, id)).get() ?? null;
    },

    listBetween(
      from: string,
      to: string,
      filters: RequestFilters,
      limit: number,
      offset = 0,
    ): RequestRow[] {
      return (
        db
          .select()
          .from(requests)
          .where(windowWhere(from, to, filters))
          // The id breaks the tie, so two rows written in the same millisecond — a
          // combo's fallback, or a burst of clients — keep a stable order between
          // one page and the next rather than shuffling.
          .orderBy(desc(requests.at), desc(requests.id))
          .limit(limit)
          .offset(offset)
          .all()
      );
    },

    countBetween(from: string, to: string, filters: RequestFilters): number {
      return (
        db
          .select({ value: sql<number>`count(*)` })
          .from(requests)
          .where(windowWhere(from, to, filters))
          .get()?.value ?? 0
      );
    },

    totals(from: string, to: string): UsageTotalsRow {
      const row = db
        .select({
          requests: sql<number>`count(*)`,
          // `sum(case ...)` rather than a filtered count, because SQLite has no
          // `count(*) filter (where ...)` and the case form works everywhere.
          errors: sql<number>`coalesce(sum(case when ${requests.status} >= 400 then 1 else 0 end), 0)`,
          inputTokens: sql<number>`coalesce(sum(${requests.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${requests.outputTokens}), 0)`,
          cachedInputTokens: sql<number>`coalesce(sum(${requests.cachedInputTokens}), 0)`,
          costUsd: sql<number>`coalesce(sum(${requests.costUsd}), 0)`,
          // `avg` skips nulls, which is exactly right: a turn with no first token
          // must not be counted as a turn that had one at zero.
          avgTtftMs: sql<number | null>`avg(${requests.ttftMs})`,
          avgLatencyMs: sql<number | null>`avg(${requests.latencyMs})`,
        })
        .from(requests)
        .where(windowWhere(from, to))
        .get();

      return {
        requests: row?.requests ?? 0,
        errors: row?.errors ?? 0,
        inputTokens: row?.inputTokens ?? 0,
        outputTokens: row?.outputTokens ?? 0,
        cachedInputTokens: row?.cachedInputTokens ?? 0,
        costUsd: row?.costUsd ?? 0,
        avgTtftMs: row?.avgTtftMs ?? null,
        avgLatencyMs: row?.avgLatencyMs ?? null,
      };
    },

    series(from: string, to: string, bucketSeconds: number): UsageBucketRow[] {
      // The bucket key is computed by SQLite from the stored ISO timestamp, so
      // the grouping happens where the data is rather than by pulling every row
      // into JavaScript to count it. `unixepoch` then integer division gives a
      // fixed-width bucket for any size, including the 7- and 30-day windows
      // where an hour-wide bar would be thousands of points.
      //
      // `%f` rather than `%S` for the seconds: it is `SS.SSS`, which is exactly
      // the shape `toISOString()` writes and therefore the shape the caller's own
      // bucket grid produces. With `%S` the two would differ by three characters
      // and every bucket would look empty — a chart of zeroes, from a mismatch.
      const bucket = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', (unixepoch(${requests.at}) / ${bucketSeconds}) * ${bucketSeconds}, 'unixepoch')`;

      return db
        .select({
          bucket,
          requests: sql<number>`count(*)`,
          errors: sql<number>`coalesce(sum(case when ${requests.status} >= 400 then 1 else 0 end), 0)`,
          inputTokens: sql<number>`coalesce(sum(${requests.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${requests.outputTokens}), 0)`,
          cachedInputTokens: sql<number>`coalesce(sum(${requests.cachedInputTokens}), 0)`,
          costUsd: sql<number>`coalesce(sum(${requests.costUsd}), 0)`,
        })
        .from(requests)
        .where(windowWhere(from, to))
        .groupBy(bucket)
        .orderBy(asc(bucket))
        .all();
    },

    breakdown(from: string, to: string, dimension: BreakdownDimension): BreakdownRow[] {
      const column = BREAKDOWN_COLUMN[dimension];
      const rows = db
        .select({
          // `coalesce` so an unattributed row lands under a name rather than a
          // null key the contract cannot carry.
          key: sql<string>`coalesce(${column}, 'unknown')`,
          requests: sql<number>`count(*)`,
          tokens: sql<number>`coalesce(sum(${requests.inputTokens}), 0) + coalesce(sum(${requests.outputTokens}), 0)`,
          costUsd: sql<number>`coalesce(sum(${requests.costUsd}), 0)`,
        })
        .from(requests)
        .where(windowWhere(from, to))
        .groupBy(column)
        .all();

      // Sorted here rather than in SQL: the ranking is by request count, and the
      // console shows a share, which it derives from the total.
      return rows.sort((left, right) => right.requests - left.requests);
    },

    savingsTotals(from: string, to: string): SavingsTotalsRow {
      // The window predicate is repeated rather than shared with `windowWhere`
      // because that helper also applies the console's *filters*, and this read
      // has none: the savings page is about the instance, not about a slice of
      // the request log.
      const row = db
        .select({
          requests: sql<number>`count(*)`,
          tokensIn: sql<number>`coalesce(sum(json_extract(${requests.tokenSaverSavings}, '$.tokensIn')), 0)`,
          tokensOut: sql<number>`coalesce(sum(json_extract(${requests.tokenSaverSavings}, '$.tokensOut')), 0)`,
          tokensSaved: sql<number>`coalesce(sum(json_extract(${requests.tokenSaverSavings}, '$.tokensSaved')), 0)`,
        })
        .from(requests)
        .where(
          and(gte(requests.at, from), lt(requests.at, to), isNotNull(requests.tokenSaverSavings)),
        )
        .get();

      return {
        requests: row?.requests ?? 0,
        tokensIn: row?.tokensIn ?? 0,
        tokensOut: row?.tokensOut ?? 0,
        tokensSaved: row?.tokensSaved ?? 0,
      };
    },

    savingsByStage(from: string, to: string): StageSavingsRow[] {
      // `json_each` is a table-valued function: one row per element of the array,
      // which is what turns "one JSON document per turn" into a `group by` over
      // stages. A row whose column is NULL contributes no elements, so the join
      // drops it — no null check needed, and that is the behaviour being relied
      // on rather than an accident.
      //
      // Raw rather than the query builder because Drizzle has no construct for a
      // table-valued function in a `from`. The two values interpolated are the
      // window bounds, which are bound as parameters, not spliced.
      return db.all<StageSavingsRow>(sql`
        select json_extract(value, '$.stageId') as stageId,
               coalesce(sum(json_extract(value, '$.bytesIn')), 0) as bytesIn,
               coalesce(sum(json_extract(value, '$.bytesOut')), 0) as bytesOut,
               coalesce(sum(json_extract(value, '$.tokensSaved')), 0) as tokensSaved
        from ${requests}, json_each(${requests.tokenSaverSavings}, '$.stages')
        where ${requests.at} >= ${from} and ${requests.at} < ${to}
        group by 1
      `);
    },

    savingsSeries(from: string, to: string, bucketSeconds: number): SavingsPointRow[] {
      // The same bucket expression `series` uses, and for the same reasons — see
      // the note there about `%f` and about grouping where the data is.
      const bucket = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', (unixepoch(${requests.at}) / ${bucketSeconds}) * ${bucketSeconds}, 'unixepoch')`;

      return db
        .select({
          bucket,
          tokensSaved: sql<number>`coalesce(sum(json_extract(${requests.tokenSaverSavings}, '$.tokensSaved')), 0)`,
        })
        .from(requests)
        .where(
          and(gte(requests.at, from), lt(requests.at, to), isNotNull(requests.tokenSaverSavings)),
        )
        .groupBy(bucket)
        .orderBy(asc(bucket))
        .all();
    },

    endpointStats(from: string, to: string): EndpointStatsRow[] {
      return db
        .select({
          path: requests.path,
          requests: sql<number>`count(*)`,
          errors: sql<number>`coalesce(sum(case when ${requests.status} >= 400 then 1 else 0 end), 0)`,
          avgLatencyMs: sql<number | null>`avg(${requests.latencyMs})`,
        })
        .from(requests)
        .where(windowWhere(from, to))
        .groupBy(requests.path)
        .all();
    },

    recentErrors(limit: number): RequestRow[] {
      return db
        .select()
        .from(requests)
        .where(gte(requests.status, 400))
        .orderBy(desc(requests.at))
        .limit(limit)
        .all();
    },

    deleteOlderThan(before: string): number {
      const gone =
        db
          .select({ value: sql<number>`count(*)` })
          .from(requests)
          .where(lt(requests.at, before))
          .get()?.value ?? 0;
      if (gone === 0) return 0;
      db.delete(requests).where(lt(requests.at, before)).run();
      return gone;
    },

    capturesFor(requestId: string, now: string): CaptureRow[] {
      return db
        .select()
        .from(requestCaptures)
        .where(and(eq(requestCaptures.requestId, requestId), gte(requestCaptures.expiresAt, now)))
        .orderBy(asc(requestCaptures.capturedAt))
        .all();
    },

    saveCapture(insert: CaptureInsert): void {
      db.insert(requestCaptures).values(insert).run();
    },

    deleteExpiredCaptures(now: string): number {
      const gone =
        db
          .select({ value: sql<number>`count(*)` })
          .from(requestCaptures)
          .where(lt(requestCaptures.expiresAt, now))
          .get()?.value ?? 0;
      if (gone === 0) return 0;
      db.delete(requestCaptures).where(lt(requestCaptures.expiresAt, now)).run();
      return gone;
    },

    capturedRequestIds(requestIds: readonly string[], now: string): Set<string> {
      if (requestIds.length === 0) return new Set();
      const rows = db
        .selectDistinct({ requestId: requestCaptures.requestId })
        .from(requestCaptures)
        .where(
          and(
            gte(requestCaptures.expiresAt, now),
            inArray(requestCaptures.requestId, [...requestIds]),
          ),
        )
        .all();
      return new Set(rows.map((row) => row.requestId));
    },
  };
}
