import type { Migration } from './types.ts';

/**
 * Auth and API keys (C2, D8).
 *
 * Three tables. `auth_credential` holds exactly one row — the single operator
 * (ADR-0008) — and the repository is what enforces "one", because SQLite has no
 * natural way to say it. `created_by` on `api_keys` is a plain nullable column
 * rather than a foreign key: it is the v2 multi-user hook, and an FK to today's
 * single-row table would have to be dropped in a migration once a real `users`
 * table exists.
 *
 * Model lists and the client-router denylist are stored as JSON text: they are
 * small, read whole, and never queried by element, so a join table would be
 * overhead with no benefit.
 */
export const migration0002: Migration = {
  id: 2,
  name: 'auth',
  statements: [
    `create table auth_credential (
       id text primary key,
       password_hash text not null,
       instance_name text not null,
       created_at text not null,
       updated_at text not null
     );`,

    `create table sessions (
       id text primary key,
       token_hash text not null unique,
       created_at text not null,
       expires_at text not null
     );`,

    `create index sessions_expires_at_idx on sessions (expires_at);`,

    `create table api_keys (
       id text primary key,
       name text not null,
       prefix text not null,
       secret_hash text not null unique,
       models_allowed text not null default '[]',
       models_denied text not null default '[]',
       budget_requests integer,
       budget_tokens integer,
       tps_limit integer,
       rate_limit_per_minute integer,
       expires_at text,
       client_router_denylist text not null default '[]',
       created_by text,
       revoked_at text,
       last_used_at text,
       usage_requests integer not null default 0,
       usage_input_tokens integer not null default 0,
       usage_output_tokens integer not null default 0,
       created_at text not null
     );`,

    `create index api_keys_prefix_idx on api_keys (prefix);`,
  ],
};
