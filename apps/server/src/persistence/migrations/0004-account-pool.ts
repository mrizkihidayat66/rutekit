import type { Migration } from './types.ts';

/**
 * The account pool's columns (C5a, FR-3.x).
 *
 * `0003` created the account row with only what a sign-in has to write. This
 * adds what the state machine reads and writes: where the account is in its
 * lifecycle, how long it is resting, how many times it has failed in a row, when
 * it was last used, and what the provider last said about its quota.
 *
 * `in_flight` is a mirror, not the truth. The pool counts in-flight turns in
 * memory and writes the column so the console has something to read; a restart
 * clears both, which is correct — no request outlives the process that sent it.
 * The `default 0` is what makes the column safe to add to rows that already
 * exist: every account that predates the pool is idle by definition.
 *
 * `alter table` per column rather than a table rebuild: SQLite applies each
 * `add column` in place, and the runner wraps the whole list in one transaction,
 * so a failure half-way leaves the table as it was.
 */
export const migration0004: Migration = {
  id: 4,
  name: 'account-pool',
  statements: [
    `alter table provider_accounts add column in_flight integer not null default 0;`,
    `alter table provider_accounts add column cooldown_until text;`,
    `alter table provider_accounts add column consecutive_failures integer not null default 0;`,
    `alter table provider_accounts add column last_used_at text;`,
    `alter table provider_accounts add column quota_window_seconds integer;`,
    `alter table provider_accounts add column quota_limit real;`,
    `alter table provider_accounts add column quota_remaining real;`,
    `alter table provider_accounts add column quota_reset_at text;`,
    `alter table provider_accounts add column credit_balance real;`,
    `alter table provider_accounts add column credit_currency text;`,

    // Selection reads by provider and filters on state, and the recovery sweep
    // scans by state alone; both are hot enough to want an index.
    `create index provider_accounts_state_idx on provider_accounts (state);`,
  ],
};
