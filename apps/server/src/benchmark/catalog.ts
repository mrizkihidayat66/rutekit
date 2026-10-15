import type {
  BenchmarkResult,
  BenchmarkRun,
  BenchmarkSummary,
  BenchmarksResponse,
  ListQuery,
  SearchQuery,
} from '@contracts';
import {
  benchmarkResultSchema,
  benchmarkRunSchema,
  benchmarkSummarySchema,
} from '@contracts';

import { AppError } from '@server/errors.ts';
import type {
  BenchmarkRepository,
  BenchmarkResultRow,
  BenchmarkRunRow,
} from '@server/persistence/benchmark.ts';

/**
 * The Benchmark's read models (C11, FR-9.3).
 *
 * Two shapes for one run, and the difference between them is the point: the list
 * answers with a **summary** — the run without its cells, plus how many have
 * landed — and the detail answers with the whole matrix. A page of twenty runs at
 * a hundred and twenty cells each is a few hundred kilobytes of output that
 * nothing on the list page reads, and the count is the only thing it does read.
 *
 * **A stored row that does not parse is an error, not a gap.** Every column is
 * written by rutekit from contract-validated input, so a row the schema rejects
 * means the database was edited outside the process. Dropping it from a listing
 * would hide the one thing an operator needs to find; failing names it.
 *
 * The percentages, means and comparisons are all computed on the *page*, from
 * the run's own cells — `apps/web/src/routes/pages/benchmark/benchmark.ts` already
 * has that arithmetic and this file deliberately does not duplicate it. What the
 * server owes the page is the matrix in a stable order and the two durations as
 * separate fields.
 */

export interface BenchmarkCatalog {
  list(query: SearchQuery): BenchmarksResponse;
  get(id: string): BenchmarkRun;
}

export interface BenchmarkCatalogDeps {
  readonly runs: BenchmarkRepository;
}

/** One stored cell as the contract reads it. */
export function toBenchmarkResult(row: BenchmarkResultRow): BenchmarkResult {
  return benchmarkResultSchema.parse({
    id: row.id,
    variantId: row.variantId,
    providerId: row.providerId,
    model: row.model,
    status: row.status,
    ttftMs: row.ttftMs,
    latencyMs: row.latencyMs,
    outputTokens: row.outputTokens,
    tokensPerSecond: row.tokensPerSecond,
    costUsd: row.costUsd,
    qualityScore: row.qualityScore,
    outputPreview: row.outputPreview,
    error: row.error,
  });
}

/** One stored run with its cells, as the contract reads it. */
export function toBenchmarkRun(
  row: BenchmarkRunRow,
  cells: readonly BenchmarkResultRow[],
): BenchmarkRun {
  return benchmarkRunSchema.parse({
    id: row.id,
    name: row.name,
    status: row.status,
    template: row.template,
    variants: row.variants,
    targets: row.targets,
    results: cells.map(toBenchmarkResult),
    expectedResultCount: row.expectedResultCount,
    systemPrompt: row.systemPrompt,
    rubric: row.rubric,
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  });
}

/** The same run without its cells, for the list. */
export function toBenchmarkSummary(row: BenchmarkRunRow, resultCount: number): BenchmarkSummary {
  return benchmarkSummarySchema.parse({
    id: row.id,
    name: row.name,
    status: row.status,
    template: row.template,
    variants: row.variants,
    targets: row.targets,
    expectedResultCount: row.expectedResultCount,
    systemPrompt: row.systemPrompt,
    rubric: row.rubric,
    error: row.error,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    resultCount,
  });
}

export function createBenchmarkCatalog(deps: BenchmarkCatalogDeps): BenchmarkCatalog {
  return {
    list(query: SearchQuery): BenchmarksResponse {
      const needle = query.q.trim().toLowerCase();
      let rows = deps.runs.listRuns();
      if (needle !== '') {
        rows = rows.filter((row) => row.name.toLowerCase().includes(needle));
      }

      // One query for every run's cell count rather than one per run: the list is
      // the endpoint that would otherwise be N+1 by construction.
      const counts = deps.runs.resultCounts();
      const summaries = rows.map((row) => toBenchmarkSummary(row, counts.get(row.id) ?? 0));

      const sorted = sortSummaries(summaries, query);
      const offset = offsetOf(query.cursor);
      const next = offset + query.limit;
      return {
        items: sorted.slice(offset, next),
        nextCursor: next < sorted.length ? String(next) : null,
        total: sorted.length,
      };
    },

    get(id: string): BenchmarkRun {
      const row = deps.runs.findRun(id);
      if (row === null) throw AppError.notFound(`No benchmark run with id ${id}.`);
      return toBenchmarkRun(row, deps.runs.resultsOf(id));
    },
  };
}

/**
 * The list's own sort.
 *
 * An absent or unrecognised `sort` leaves the repository's order — newest first —
 * alone, for the reason the other lists give: that order is what the page is read
 * for, and replacing it with an arbitrary column would make the first render
 * disagree with the ordering that matters.
 */
function sortSummaries(
  rows: readonly BenchmarkSummary[],
  query: ListQuery,
): BenchmarkSummary[] {
  const sorters: Readonly<Record<string, (row: BenchmarkSummary) => string | number>> = {
    name: (row) => row.name,
    createdAt: (row) => row.createdAt,
    status: (row) => row.status,
    resultCount: (row) => row.resultCount,
  };
  const sorter = sorters[query.sort ?? ''];
  if (sorter === undefined) return [...rows];

  const direction = query.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sorter(a);
    const right = sorter(b);
    if (left === right) return a.id.localeCompare(b.id);
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right));
    return order * direction;
  });
}

/** Cursors are plain offsets, matching what the console's pager already sends. */
function offsetOf(cursor: string | null): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
