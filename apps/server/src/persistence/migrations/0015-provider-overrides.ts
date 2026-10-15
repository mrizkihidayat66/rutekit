import type { Migration } from './types.ts';

/**
 * Providers an operator configured, and the models that are not the catalogue's
 * (C13a, FR-2.4–2.6).
 *
 * Two tables, and both exist for the same reason: **the registry is not the only
 * place a provider can come from.**
 *
 * `providers` holds BYOK endpoints — an OpenAI-compatible or Anthropic-compatible
 * base URL an operator typed (FR-2.4). The catalogue's own manifests are still
 * the curated providers and still immutable; a row here is one the operator made,
 * so it is the only kind that can be edited or removed. The registry reads both,
 * which is what makes a BYOK provider usable for routing rather than a row the
 * console can show and the router cannot reach.
 *
 * **The credential is not here.** A provider row describes an endpoint; the key
 * that opens it is an *account*, stored through the same encrypted path every
 * other credential uses. Creating a provider with a key therefore creates two
 * things, and that is the honest split: one endpoint, one credential, and the
 * pool already knows how to hold the second.
 *
 * `provider_models` holds the entries that are not the catalogue's:
 *
 *   - **`custom`** — a model an operator added by hand, which rutekit owns and
 *     may therefore edit or delete.
 *   - **`synced`** — what an endpoint answered the last time its models were
 *     fetched. The provider's own claim, so not editable: the next fetch would
 *     overwrite it, and a console that let it be edited would be storing a value
 *     it could not keep.
 *
 * The catalogue's own entries are `template` and live in the manifests — they are
 * not rows, and that is the point of `modelSourceSchema` in the contract: the
 * three sources are three different owners, and this table is two of them.
 *
 * `capabilities` is JSON: four booleans read whole, never queried into.
 */
export const migration0015: Migration = {
  id: 15,
  name: 'provider-overrides',
  statements: [
    `create table providers (
       id text primary key,
       name text not null,
       description text not null default '',
       category text not null,
       wire_family text not null,
       base_url text,
       docs_url text,
       icon text not null default 'box',
       free_tier integer not null default 0,
       created_at text not null,
       updated_at text not null
     );`,

    `create table provider_models (
       provider_id text not null,
       model_id text not null,
       source text not null,
       display_name text not null,
       context_window integer,
       max_output_tokens integer,
       capabilities text not null default '{}',
       input_price_per_mtok real,
       output_price_per_mtok real,
       deprecated integer not null default 0,
       created_at text not null,
       updated_at text not null,
       primary key (provider_id, model_id)
     );`,

    // The catalog reads every model joined to its provider, and the detail reads
    // one provider's list; both are hot.
    `create index provider_models_provider_idx on provider_models (provider_id);`,
  ],
};
