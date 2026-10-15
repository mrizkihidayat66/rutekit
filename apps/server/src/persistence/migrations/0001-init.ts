import type { Migration } from './types.ts';

/**
 * The first migration: the meta table the boot marker is written to. Its job in
 * C1 is to prove the mechanism — applied at boot, recorded, never re-applied.
 */
export const migration0001: Migration = {
  id: 1,
  name: 'init',
  statements: [
    `create table app_meta (
       key text primary key,
       value text not null,
       updated_at text not null
     );`,
  ],
};
