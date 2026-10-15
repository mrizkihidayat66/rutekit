/**
 * One numbered schema change.
 *
 * A released migration is immutable (R5.8): the id is never reused, the
 * statements are never edited, and a correction is a new migration with the next
 * id. The runner asserts the ids are contiguous from 1, so a mis-numbered or
 * deleted entry fails at boot rather than silently skipping a change.
 */
export interface Migration {
  /** 1-based, contiguous across the whole list. */
  readonly id: number;
  /** Short slug, recorded alongside the id so a migration is identifiable in the DB. */
  readonly name: string;
  /** Statements applied in one transaction, in order. */
  readonly statements: readonly string[];
}
