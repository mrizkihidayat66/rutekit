import type { Migration } from './types.ts';

/**
 * The virtual-card pool (C8, FR-11.2).
 *
 * Cards are minted in batches and drawn down as provider sign-ups need one, which
 * is why the row tracks what a card is *doing* rather than who owns it — the
 * lifecycle is `active` → `reserved` → `used`/`declined`, and it is a one-way
 * street in practice.
 *
 * **`pan_envelope` and `cvv_envelope` are encrypted, and the read model never
 * carries them.** A console that listed every number would be a cardholder-data
 * store with a UI. `masked_number` is what the table shows, `last4` is the
 * searchable key, and the two envelopes are read only by the reveal endpoint —
 * one card at a time, because an operator has to type one number into one form.
 *
 * **`has_pan` is a column rather than a derivation.** A card an operator recorded
 * by hand from an issuer that only showed them the masked form has no envelope,
 * and "no number held" is a fact the UI needs in order to hide the reveal button
 * rather than offer one that fails.
 *
 * The BIN catalogue is *not* a table. It is a short curated list the generator
 * ships with, it changes when rutekit is upgraded rather than when an operator
 * edits something, and a table would buy a migration and a repository for a list
 * nothing ever writes to.
 */
export const migration0009: Migration = {
  id: 9,
  name: 'vcc',
  statements: [
    `create table vcc_cards (
       id text primary key,
       brand text not null,
       bin text not null,
       last4 text not null,
       masked_number text not null,
       pan_envelope text,
       cvv_envelope text,
       has_pan integer not null default 0,
       expiry_month integer not null,
       expiry_year integer not null,
       holder_name text not null,
       country text,
       currency text not null,
       status text not null default 'active',
       source text not null,
       assigned_to text,
       note text,
       created_at text not null,
       updated_at text not null
     );`,

    // The pool is read filtered by status (what is still free) and by brand, and
    // the sign-up path looks a card up by its last four.
    `create index vcc_cards_status_idx on vcc_cards (status);`,
    `create index vcc_cards_brand_idx on vcc_cards (brand);`,
    `create index vcc_cards_last4_idx on vcc_cards (last4);`,
  ],
};
