import type { Migration } from './types.ts';

/**
 * The automation's two credential pools (C7a, FR-5.x).
 *
 * A bulk import drives a browser somewhere, and the two things it needs to do
 * that are a network egress and — for registration — a phone number. Both are
 * pools of credentials an operator buys and pastes in, both are used the same
 * way (pick one that still works, fall back to the next), and both therefore
 * need the same three things: a masked read model, an encrypted secret, and a
 * health column that a check-in refreshes.
 *
 * **`credential_envelope` is the same column as `provider_accounts`.** A proxy's
 * `username:password` and an SMS key are encrypted by the same `SecretBox` and
 * are just as write-only: the read model carries `hasAuth` or `keyHint` and never
 * the secret (R5.10, SEC-2). A repository here never holds the box — decrypting is
 * a decision about whether a credential is still good, and that belongs to the
 * prober, not to the store.
 *
 * **`dispatch_count` is a counter, not a log.** It exists so the pool page can
 * show which egress is actually carrying traffic; C7b increments it as it hands a
 * proxy to a worker. It is not an audit trail and nothing derives a decision from
 * it.
 *
 * Health columns are nullable rather than defaulted to a verdict: `untested` is a
 * real state (a proxy added a second ago) and is not the same fact as `dead`. The
 * status text itself is derived from `last_checked_at` being null, so a pool that
 * has never been checked cannot be mistaken for one that was checked and failed.
 */
export const migration0007: Migration = {
  id: 7,
  name: 'automation-pools',
  statements: [
    `create table proxies (
       id text primary key,
       protocol text not null default 'http',
       host text not null,
       port integer not null,
       credential_envelope text,
       health text not null default 'untested',
       latency_ms real,
       last_checked_at text,
       dispatch_count integer not null default 0,
       note text,
       created_at text not null,
       updated_at text not null
     );`,

    // The pool is read filtered by health (what still works) and by protocol
    // (which egress a job can use), and both are hot enough to want an index.
    `create index proxies_health_idx on proxies (health);`,
    `create index proxies_protocol_idx on proxies (protocol);`,

    `create table sms_providers (
       id text primary key,
       kind text not null default '5sim',
       label text not null,
       credential_envelope text,
       key_hint text,
       status text not null default 'untested',
       balance real,
       currency text,
       country text,
       operator text,
       product text,
       success_count integer not null default 0,
       fail_count integer not null default 0,
       last_checked_at text,
       note text,
       created_at text not null,
       updated_at text not null
     );`,

    `create index sms_providers_status_idx on sms_providers (status);`,
  ],
};
