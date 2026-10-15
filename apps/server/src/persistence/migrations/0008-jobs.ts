import type { Migration } from './types.ts';

/**
 * Automation jobs (C7b, FR-5.x).
 *
 * Two tables, and the split between them is the split between the batch and its
 * ledger: a `jobs` row is the run, a `job_items` row is one credential in it.
 *
 * **Steps are deliberately not here.** A step is written for every stage of every
 * item — a two-hundred-account batch at eight steps each is sixteen hundred rows
 * — and every one of them is already streamed to the console over the socket the
 * moment it happens. Persisting them would be a second copy of a live feed, kept
 * for a reader who is not watching. So a live job's steps live in the manager's
 * memory and reach the console over WS; what survives a restart is the durable
 * fact: which items ran, how many times, and how they ended.
 *
 * **`payload_envelope` holds the batch's credentials, encrypted.** A bulk import
 * is given `email:password` lines and produces accounts from them, so the batch
 * cannot run without them. They are encrypted with the same `SecretBox` the
 * provider accounts use and are never in a read model — the contract carries
 * masked labels and counters, and nothing else. Keeping them is what makes
 * `retry_failed` work after a restart; the alternative was to hold them in memory
 * only, at the cost of a job whose failures could be looked at but not re-run.
 *
 * **`attempts` is the worker's count, mirrored.** The worker runs the retry loop
 * (it is the process that can see whether an attempt failed in a way worth
 * retrying), so the host records what the worker reports rather than deciding it.
 * The column exists so the ledger survives a crash mid-item.
 *
 * `manual_worker_id` and `manual_deadline_at` are the host's, not the worker's:
 * the countdown the operator watches and the clock that abandons a blocked item
 * have to be the same clock, and only the host has one the console can read.
 */
export const migration0008: Migration = {
  id: 8,
  name: 'jobs',
  statements: [
    `create table jobs (
       id text primary key,
       provider_id text not null,
       method text not null,
       engine text,
       mode text,
       proxy_id text,
       status text not null default 'queued',
       concurrency integer not null default 1,
       effective_concurrency integer,
       sms_provider_id text,
       quantity integer,
       total integer not null default 0,
       succeeded integer not null default 0,
       failed integer not null default 0,
       needs_manual integer not null default 0,
       manual_worker_id text,
       manual_deadline_at text,
       payload_envelope text,
       last_error text,
       created_at text not null,
       started_at text,
       finished_at text,
       updated_at text not null
     );`,

    `create table job_items (
       id text primary key,
       job_id text not null,
       position integer not null,
       account_label text not null,
       status text not null default 'queued',
       attempts integer not null default 0,
       max_attempts integer not null default 3,
       last_error text,
       started_at text,
       finished_at text,
       updated_at text not null
     );`,

    // The list is read newest-first and filtered by status and provider, and the
    // detail reads one job's items in order; both are hot enough to want an index.
    `create index jobs_status_idx on jobs (status);`,
    `create index jobs_provider_idx on jobs (provider_id);`,
    `create index job_items_job_idx on job_items (job_id, position);`,
  ],
};

