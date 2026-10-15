import type { Migration } from './types.ts';

/**
 * Provider accounts (C3b2, D6).
 *
 * The first domain table. It lands with the phase that gives it a shape: OAuth
 * cannot finish without somewhere to put the token it just exchanged, and the
 * row is not a guess because `accountSchema` in `packages/contracts` already
 * settled what an account *is* — this table is the write half of it.
 *
 * `credential_envelope` holds the AES-256-GCM envelope from `SecretBox`, never
 * the credential (R5.10). It is the one column with no read path: the console's
 * account model carries a masked email and nothing else, so a repository that
 * returned this column to a route would be the bug, not the schema.
 *
 * The state machine's columns (cooldown, in-flight, consecutive failures, quota
 * window) belong to the pool in C5 and arrive in their own migration. What is
 * here is only what the sign-in itself has to write: which provider, which mode,
 * a label, and the envelope.
 */
export const migration0003: Migration = {
  id: 3,
  name: 'provider-accounts',
  statements: [
    `create table provider_accounts (
       id text primary key,
       provider_id text not null,
       label text not null,
       credential_envelope text not null,
       auth_mode text not null,
       email_masked text,
       state text not null default 'active',
       state_reason text,
       max_in_flight integer not null default 1,
       note text,
       created_at text not null,
       updated_at text not null
     );`,

    `create index provider_accounts_provider_id_idx on provider_accounts (provider_id);`,
  ],
};
