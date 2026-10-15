import { TIME_WINDOW_MS, type TimeWindow } from '@contracts';

/**
 * Turning a window name into a time range and a bucket size.
 *
 * Two questions the charts ask that the contract cannot answer: when does
 * "24h" start, and how wide is one bar. The first is arithmetic; the second is a
 * judgement, and the judgement is that **a chart is read at roughly a hundred
 * points**. Fewer and the line is too coarse to see a spike; more and every point
 * is a fraction of a pixel while the query scans the same rows.
 *
 * `all` has no fixed span, so it starts at the epoch and buckets by day — the
 * only size that keeps a month-long series readable, and the only one that does
 * not grow without bound as the instance ages.
 */

/** Bucket width per window, chosen to land near a hundred points. */
const BUCKET_SECONDS: Readonly<Record<TimeWindow, number>> = {
  '1h': 60, // 60 points
  '6h': 300, // 72 points
  '12h': 900, // 48 points
  '24h': 3600, // 24 points
  '7d': 21600, // 28 points
  '30d': 86400, // 30 points
  all: 86400,
};

export interface WindowRange {
  /** Inclusive lower bound, ISO-8601. */
  readonly from: string;
  /** Exclusive upper bound, ISO-8601 — "now", so a row written this instant counts. */
  readonly to: string;
  readonly bucketSeconds: number;
}

export function windowRange(window: TimeWindow, now: Date): WindowRange {
  const to = now.getTime();
  const span = window === 'all' ? null : TIME_WINDOW_MS[window];
  // The epoch is the honest floor for `all`: the retention sweep is what bounds
  // the scan, not the window, and a row older than retention cannot exist.
  const from = span === null ? 0 : to - span;

  return {
    from: new Date(from).toISOString(),
    to: new Date(to + 1).toISOString(),
    bucketSeconds: BUCKET_SECONDS[window],
  };
}

/**
 * Every bucket start in the range, in order.
 *
 * Computed from the range rather than from the rows, which is what fills the
 * gaps: a `GROUP BY` returns only the buckets that have rows, so a quiet hour is
 * absent rather than zero, and a chart drawn from that list would make a busy
 * hour look adjacent to another one six hours later.
 *
 * Aligned to the bucket grid, so the keys match what SQLite computed for the
 * rows: `unixepoch / step * step` floors to the same boundaries. The last bucket
 * is the one containing "now", so the chart's right edge is the present rather
 * than the last request.
 *
 * Lives here rather than beside either caller because two series now read it —
 * usage and the Token Saver's savings — and a grid rule kept in two places is a
 * grid rule that can disagree with itself.
 */
export function bucketStarts(range: WindowRange): string[] {
  const stepMs = range.bucketSeconds * 1000;
  const fromMs = Date.parse(range.from);
  const toMs = Date.parse(range.to);
  const start = Math.floor(fromMs / stepMs) * stepMs;

  const starts: string[] = [];
  for (let at = start; at <= toMs; at += stepMs) {
    starts.push(new Date(at).toISOString());
  }
  return starts;
}
