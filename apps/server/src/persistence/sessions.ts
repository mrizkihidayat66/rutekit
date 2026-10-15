import { eq, lt, ne } from 'drizzle-orm';

import type { Db } from './client.ts';
import { sessions } from './schema.ts';

/**
 * Console sessions.
 *
 * The row holds the SHA-256 of the cookie value, never the value itself (R5.10),
 * so a leaked database cannot be replayed as a login.
 *
 * `deleteExpired` exists because expiry is not deletion: a row past its
 * `expires_at` is already refused when the cookie is presented, and this is the
 * sweep that keeps the table from growing without bound.
 */

export type SessionRecord = typeof sessions.$inferSelect;

export interface SessionsRepository {
  create(record: SessionRecord): void;
  findByTokenHash(tokenHash: string): SessionRecord | null;
  /** Slide the expiry forward on a session that is still in use. */
  touch(id: string, expiresAt: string): void;
  delete(id: string): void;
  /** Removes every session already past `nowIso`; returns how many went. */
  deleteExpired(nowIso: string): number;
  /** Keeps one session and drops the rest — what a password change does. */
  deleteOthers(keepId: string): number;
}

export function createSessionsRepository(db: Db): SessionsRepository {
  return {
    create(record: SessionRecord): void {
      db.insert(sessions).values(record).run();
    },

    findByTokenHash(tokenHash: string): SessionRecord | null {
      return db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).get() ?? null;
    },

    touch(id: string, expiresAt: string): void {
      db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id)).run();
    },

    delete(id: string): void {
      db.delete(sessions).where(eq(sessions.id, id)).run();
    },

    deleteExpired(nowIso: string): number {
      return db
        .delete(sessions)
        .where(lt(sessions.expiresAt, nowIso))
        .returning({ id: sessions.id })
        .all().length;
    },

    deleteOthers(keepId: string): number {
      return db
        .delete(sessions)
        .where(ne(sessions.id, keepId))
        .returning({ id: sessions.id })
        .all().length;
    },
  };
}
