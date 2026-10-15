import type { Migration } from './types.ts';

/**
 * Routing records (C5b, FR-1.3–1.5).
 *
 * Four tables for the three records the console's Routing section owns. Three of
 * them are the ones a reader would guess — an alias, a combo, a mapping — and the
 * fourth is the combo's entry list, which is a table rather than a JSON column
 * for one reason: the order of the entries *is* the meaning of a sequential
 * combo, and a JSON array would put that order somewhere no `order by` can see.
 *
 * `aliases.alias` and `combos.name` are `unique`. Both are names a client puts in
 * `model:` and both are looked up by exactly that name, so a duplicate would not
 * be a style problem — it would make resolution depend on row order.
 *
 * `weight` is `real`, not `integer`, because `comboEntryInputSchema` accepts any
 * positive number and the console's own field is free text. Storing it as an
 * integer would silently truncate `0.5` to `0` and turn a weighted combo into a
 * broken one.
 *
 * No foreign key from `combo_entries` to `combos`: SQLite enforces them only with
 * `pragma foreign_keys = on`, which the connection does not set, so a declared
 * key would be a comment pretending to be a constraint. The service deletes a
 * combo's entries in the same transaction that deletes the combo, and that is the
 * guarantee that actually holds.
 */
export const migration0005: Migration = {
  id: 5,
  name: 'routing',
  statements: [
    `create table aliases (
       id text primary key,
       alias text not null unique,
       target text not null,
       provider_id text,
       enabled integer not null default 1,
       description text,
       created_at text not null,
       updated_at text not null
     );`,

    `create table combos (
       id text primary key,
       name text not null unique,
       display_name text not null,
       description text,
       strategy text not null default 'sequential',
       fallback_on_error integer not null default 1,
       enabled integer not null default 1,
       created_at text not null,
       updated_at text not null
     );`,

    `create table combo_entries (
       id text primary key,
       combo_id text not null,
       model text not null,
       provider_id text,
       weight real not null default 1,
       enabled integer not null default 1,
       position integer not null
     );`,

    `create table model_mappings (
       id text primary key,
       match text not null,
       pattern text not null,
       replacement text not null,
       priority integer not null default 0,
       enabled integer not null default 1,
       description text,
       created_at text not null,
       updated_at text not null
     );`,

    // Resolution reads a combo's entries by `combo_id` on every turn that names
    // one, and the mapping list is read whole but ordered by priority.
    `create index combo_entries_combo_id_idx on combo_entries (combo_id, position);`,
    `create index model_mappings_priority_idx on model_mappings (priority, created_at);`,
  ],
};
