import type { Migration } from './types.ts';

/**
 * Model verification: results and the baselines they are measured against (C12,
 * FR-10.x).
 *
 * Two tables, and the split between them is a lifetime: a **result** is one
 * verdict about one endpoint at one moment, while a **baseline** is a reference
 * distribution that outlives every result measured against it. A baseline is
 * calibrated once from an endpoint the operator trusts and then read by every
 * later verification, so putting it on the result would mean re-measuring the
 * reference for every probe — which is exactly the cost the calibration step
 * exists to avoid.
 *
 * **A baseline's subject is a family or a model, and which one it is decides what
 * the verdict can say.** That is not decoration: a family baseline can confirm
 * "this behaves like an Anthropic model" and can never confirm "this is
 * claude-3-opus-20240229", because the reference was never measured from one
 * specific build. `is_family` is stored rather than derived from the subject
 * string, because a model id is an arbitrary string and a family name is too —
 * nothing about `gpt-4o` says it is a model and nothing about `openai` says it
 * is a family.
 *
 * **The distribution is JSON, keyed by token.** A single-token distribution is
 * `token → share` over a small fixed vocabulary, read whole and never queried
 * into. A row per token would be a join for every probe of every verification.
 *
 * **`verification_results` keeps its signals and its posterior as JSON too.** The
 * signals are a fixed-length list produced once and read whole; the posterior is
 * a small distribution. Neither is filtered or sorted by, and both are written in
 * the same transaction as the row — a result whose posterior is missing is a
 * verdict with no evidence behind it, which is the one shape this feature must
 * never produce.
 */
export const migration0014: Migration = {
  id: 14,
  name: 'verification',
  statements: [
    `create table verification_results (
       id text primary key,
       provider_id text not null,
       model text not null,
       claimed_family text not null,
       verdict text not null,
       confidence real not null default 0,
       posterior text not null default '[]',
       signals text not null default '[]',
       probes_used integer not null default 0,
       duration_ms real not null default 0,
       notes text,
       created_at text not null
     );`,

    `create table verification_baselines (
       subject text not null,
       probe_id text not null,
       is_family integer not null default 0,
       distribution text not null default '{}',
       samples integer not null default 0,
       provider_id text not null,
       model text not null,
       calibrated_at text not null,
       primary key (subject, probe_id)
     );`,

    // The history is read newest-first, and a verification reads every baseline
    // for one subject.
    `create index verification_results_created_idx on verification_results (created_at);`,
    `create index verification_baselines_subject_idx on verification_baselines (subject);`,
  ],
};
