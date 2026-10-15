import type { Migration } from './types.ts';

/**
 * Client-supplied content filter rules (C8, FR-11.3).
 *
 * A separate migration from `0009` rather than part of it, and that is the rule
 * working as intended: `0009` had already been applied to a running database by
 * the time this table was designed, so it is released, and a released migration
 * is immutable (R5.8). Bumping is cheap; editing an applied migration leaves two
 * databases that both claim the same version and disagree about what it means.
 *
 * `phase` is a column rather than two tables because a rule is one thing that
 * happens at one of two moments — an operator moving a rule between phases is
 * editing it, not moving it between homes.
 *
 * `position` orders rules within a phase. The order matters because a `block`
 * rule stops the walk, so which rule is reached first is a decision the operator
 * made; storing it rather than deriving it from insertion order keeps that
 * decision stable across edits.
 */
export const migration0010: Migration = {
  id: 10,
  name: 'filter-rules',
  statements: [
    `create table filter_rules (
       id text primary key,
       name text not null,
       kind text not null,
       pattern text not null,
       action text not null,
       phase integer not null,
       enabled integer not null default 1,
       position integer not null default 0,
       created_at text not null,
       updated_at text not null
     );`,

    // The pipeline reads every rule on every turn, ordered by phase then
    // position — the same pair the index is on.
    `create index filter_rules_order_idx on filter_rules (phase, position);`,
  ],
};
