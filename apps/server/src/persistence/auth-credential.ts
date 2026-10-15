import { eq } from 'drizzle-orm';

import type { Db } from './client.ts';
import { authCredential } from './schema.ts';

/**
 * The single operator's credential row (ADR-0008).
 *
 * "Exactly one row" is an invariant SQL does not express here, so it lives in
 * this file: `create` refuses a second row, and the update methods take the id
 * the caller read rather than writing whatever row happens to be there.
 *
 * Timestamps are parameters, never read from the clock in here — the service
 * owns the clock, which keeps this file deterministic under test.
 */

export type AuthCredentialRecord = typeof authCredential.$inferSelect;

export interface AuthCredentialRepository {
  get(): AuthCredentialRecord | null;
  create(record: AuthCredentialRecord): void;
  updatePasswordHash(id: string, passwordHash: string, updatedAt: string): void;
  updateInstanceName(id: string, instanceName: string, updatedAt: string): void;
}

export function createAuthCredentialRepository(db: Db): AuthCredentialRepository {
  return {
    get(): AuthCredentialRecord | null {
      return db.select().from(authCredential).limit(1).get() ?? null;
    },

    create(record: AuthCredentialRecord): void {
      if (db.select().from(authCredential).limit(1).get() !== undefined) {
        throw new Error('an auth credential already exists');
      }
      db.insert(authCredential).values(record).run();
    },

    updatePasswordHash(id: string, passwordHash: string, updatedAt: string): void {
      db.update(authCredential).set({ passwordHash, updatedAt }).where(eq(authCredential.id, id)).run();
    },

    updateInstanceName(id: string, instanceName: string, updatedAt: string): void {
      db.update(authCredential).set({ instanceName, updatedAt }).where(eq(authCredential.id, id)).run();
    },
  };
}
