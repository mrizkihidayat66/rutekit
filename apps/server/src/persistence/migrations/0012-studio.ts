import type { Migration } from './types.ts';

/**
 * Studio generations and the assets they produce (C10, FR-8.x).
 *
 * Two tables, and the split is the one the contract already draws: a
 * `studio_generations` row is a *request* — a prompt, a model, and how far along
 * it got — and a `studio_assets` row is a *file* that came out of one.
 *
 * **They are not the same table because they do not have the same lifetime.** A
 * failed render is a generation with no asset, and an operator wants it: the
 * prompt and the settings are the expensive part to retype, which is why the
 * console can load a failed job back into the composer. A deleted asset, on the
 * other hand, does not un-happen the render. Folding them would force one of
 * those facts to be a null column on the other.
 *
 * **The bytes live on disk, not here.** A 5-second video is several megabytes,
 * and SQLite stores a BLOB by copying it through the page cache on every read.
 * The row keeps the metadata and the *extension*; the file is
 * `<dataDir>/studio/<asset id>.<extension>`.
 *
 * **The extension is stored, the filename is not.** The obvious design is a
 * `file_name` column holding what the provider called the file — and it is the
 * wrong one, because that string comes from outside rutekit and would end up
 * joined to a path. Storing only the extension means the path is built from an
 * id rutekit minted itself, so no external string can name a directory. A
 * provider that returns `../../etc/passwd` produces an asset whose extension is
 * rejected, not a write outside the data directory.
 *
 * **`progress` is real, not integer.** A diffusion run reports 0.37, and rounding
 * that to a percentage here would be a loss the console cannot undo.
 *
 * `parameters` is JSON: an open bag every endpoint spells differently, and
 * nothing queries inside it. It is read whole to render the detail panel and to
 * re-seed the composer, which is the same reason the asset carries a copy.
 */
export const migration0012: Migration = {
  id: 12,
  name: 'studio',
  statements: [
    `create table studio_generations (
       id text primary key,
       kind text not null,
       status text not null default 'queued',
       provider_id text not null,
       model text not null,
       prompt text not null,
       negative_prompt text,
       progress real,
       stage text,
       asset_id text,
       error text,
       parameters text not null default '{}',
       parent_asset_id text,
       created_at text not null,
       started_at text,
       finished_at text
     );`,

    `create table studio_assets (
       id text primary key,
       kind text not null,
       mime_type text not null,
       extension text not null,
       thumbnail_extension text,
       byte_size integer not null,
       width integer,
       height integer,
       duration_seconds real,
       provider_id text not null,
       model text not null,
       prompt text not null,
       negative_prompt text,
       parameters text not null default '{}',
       parent_asset_id text,
       favorite integer not null default 0,
       created_at text not null
     );`,

    // The queue is read newest-first and filtered by status; the gallery is read
    // newest-first and filtered by kind and favourite. Both are hot.
    `create index studio_generations_status_idx on studio_generations (status, created_at);`,
    `create index studio_assets_created_idx on studio_assets (created_at);`,
    `create index studio_assets_kind_idx on studio_assets (kind);`,
  ],
};
