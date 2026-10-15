import type { Migration } from './types.ts';

/**
 * Per-request telemetry (C6, FR-12.2, FR-12.3, FR-12.4).
 *
 * One row per `/v1` turn: who asked, which model answered, how long it took, what
 * it cost, and how it ended. Every read model in the Overview section is derived
 * from this table — the dashboard's traffic chart, the usage page's summary,
 * series and breakdown, and the per-request table — so there is one place a
 * number can come from and one place a bug can be.
 *
 * **The rows expire.** `telemetryRetentionMinutes` is an operator setting and the
 * sweep deletes past it, which is what keeps a single-user instance's database
 * bounded without a rollup table to keep in step. It also bounds the read: a
 * `GROUP BY` over a window can only ever scan the rows that window could contain.
 *
 * Columns are nullable where the value genuinely may not exist:
 *
 *   - `provider_id`, `model`, `account_id` are null on a turn that failed before
 *     a provider was chosen — a 404 on an unknown model never reached one.
 *   - `api_key_id` is null for a turn refused before the key resolved.
 *   - `ttft_ms` is null for a non-streaming turn, and for one that failed before
 *     its first chunk. "No first token" and "first token at 0 ms" are different
 *     facts and the chart reads them differently.
 *   - `input_tokens` / `output_tokens` are null when the provider reported no
 *     usage — which is not the same as zero, and averaging a zero in would drag
 *     the mean toward a number nobody measured.
 *   - `cost_usd` is null when the model carries no price, so a free model and an
 *     unpriced one are distinguishable.
 *
 * `path` is stored rather than the surface name because the row is also the
 * request log an operator reads; the surface is derivable from it and a second
 * column could disagree with the first.
 *
 * No foreign keys, for the reason `0005` gives: SQLite only enforces them with
 * `pragma foreign_keys = on`, which the connection does not set. A row whose
 * account was later deleted keeps its id — it is a historical fact, and a
 * telemetry table that cascaded would lose the history it exists to hold.
 */
export const migration0006: Migration = {
  id: 6,
  name: 'telemetry',
  statements: [
    `create table requests (
       id text primary key,
       at text not null,
       method text not null,
       path text not null,
       provider_id text,
       model text,
       account_id text,
       api_key_id text,
       status integer not null,
       error_kind text,
       latency_ms real not null,
       ttft_ms real,
       input_tokens integer,
       output_tokens integer,
       cached_input_tokens integer,
       reasoning_tokens integer,
       cost_usd real,
       streamed integer not null default 0,
       request_id text
     );`,

    // Every read model filters on `at` first — a window, a chart bucket, the
    // retention sweep — so the index is on the one column they all share.
    `create index requests_at_idx on requests (at);`,
    // The breakdown groups by these, and the request table filters on them.
    `create index requests_provider_idx on requests (provider_id);`,
    `create index requests_api_key_idx on requests (api_key_id);`,

    /*
     * Redacted payload captures (SEC-6).
     *
     * Separate from `requests` because they are large and short-lived: a capture
     * lives 15 minutes by default while the request row lives for the retention
     * window, so keeping them in one table would mean the sweep either deleted
     * telemetry too early or kept bodies too long.
     *
     * `stage` names which hop the body came from, and one request has at most one
     * row per stage. `redacted` is stored rather than assumed: a panel that says
     * "redacted" when nothing was redacted is as misleading as one that stays
     * silent when something was.
     */
    `create table request_captures (
       id text primary key,
       request_id text not null,
       stage text not null,
       body text not null,
       byte_size integer not null,
       truncated integer not null default 0,
       redacted integer not null default 0,
       captured_at text not null,
       expires_at text not null
     );`,

    // Looked up by request when the inspector opens, and swept by expiry.
    `create index request_captures_request_idx on request_captures (request_id, stage);`,
    `create index request_captures_expiry_idx on request_captures (expires_at);`,
  ],
};
