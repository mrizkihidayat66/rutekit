import type { Migration } from './types.ts';

/**
 * Benchmark runs and the cells they produced (C11, FR-9.x).
 *
 * Two tables, and the split is the one the contract already draws: a
 * `benchmark_runs` row is the *experiment* — a template, its variants, the
 * targets, and the rubric every cell is scored against — and a
 * `benchmark_results` row is one cell of the matrix.
 *
 * **The cells are rows and not a JSON column, unlike the chat transcript.** The
 * transcript is read whole or not at all; a result set is read *sorted and
 * filtered* — the comparison table sorts by quality, by cost, by first token —
 * and a run is polled while its cells are still arriving, so a page that had to
 * rewrite one document per cell would be a page that writes the whole matrix per
 * cell.
 *
 * **`variants`, `targets` and `rubric` are JSON on the run.** They are the
 * experiment's declaration rather than its data: fixed at creation, read whole,
 * and nothing queries inside them. `benchmarkInputSchema` is what writes them, so
 * the stored shape and the contract's shape are the same object by construction.
 *
 * **The two durations are separate columns, and that is the point of the whole
 * feature** (ADR-0017): `ttft_ms` is the time to the first token and `latency_ms`
 * is the whole answer. They are different quantities, they are never added
 * together, and a schema that had one column would make averaging them the
 * obvious thing to do.
 *
 * **`output_preview` is truncated and the full text is not kept.** The table
 * shows a line; the cell drawer shows the same line. A run of a hundred and
 * twenty cells at a few hundred tokens each is a few hundred kilobytes of prose
 * that nothing in the console reads in full, and the answer's *text* is the
 * thing a benchmark is least likely to be compared on.
 */
export const migration0013: Migration = {
  id: 13,
  name: 'benchmark',
  statements: [
    `create table benchmark_runs (
       id text primary key,
       name text not null,
       status text not null default 'queued',
       template text not null,
       variants text not null default '[]',
       targets text not null default '[]',
       rubric text not null default '[]',
       system_prompt text,
       expected_result_count integer not null default 0,
       error text,
       workspace_dir text,
       created_at text not null,
       started_at text,
       finished_at text
     );`,

    `create table benchmark_results (
       id text primary key,
       run_id text not null,
       position integer not null,
       variant_id text not null,
       provider_id text not null,
       model text not null,
       status text not null,
       ttft_ms real,
       latency_ms real,
       output_tokens integer,
       tokens_per_second real,
       cost_usd real,
       quality_score real,
       output_preview text not null default '',
       error text
     );`,

    // The list is read newest-first and the detail reads one run's cells in
    // order; both are hot, and the cells are the table that grows.
    `create index benchmark_runs_created_idx on benchmark_runs (created_at);`,
    `create index benchmark_results_run_idx on benchmark_results (run_id, position);`,
  ],
};
