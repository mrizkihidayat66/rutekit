import { asc, eq, sql } from 'drizzle-orm';

import type { Db } from './client.ts';
import { proxies } from './schema.ts';

/**
 * The proxy pool (C7a, FR-5.x).
 *
 * The credential goes in encrypted and comes back encrypted: this repository
 * never holds a `SecretBox`, because decrypting is a decision about whether a
 * credential still works and that belongs to the prober, not to the store — the
 * same rule `provider-accounts.ts` follows.
 *
 * `recordCheck` is the only writer of the health columns, and it writes all four
 * together. A check either observed something or it did not, and splitting the
 * write would let a row carry a fresh `lastCheckedAt` beside a stale verdict.
 *
 * `incrementDispatch` is a SQL increment rather than a read-modify-write: C7b
 * hands proxies to workers concurrently, and a read-then-write would lose one of
 * two increments landing in the same instant — the exact case a counter exists
 * for.
 */

export type ProxyRow = typeof proxies.$inferSelect;
export type ProxyInsert = typeof proxies.$inferInsert;

/** The fields an operator may edit by hand. Health moves through `recordCheck`. */
export interface ProxyPatch {
  readonly protocol?: string | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly note?: string | null | undefined;
}

/**
 * What one probe observed. Null latency means it never answered.
 *
 * `checkedAt` is null for a **reset** rather than a check — a proxy whose address
 * was just edited has no verdict at all, and stamping a fresh time beside
 * `untested` would show a check that never ran. That is why the timestamp is part
 * of this write rather than a separate call: the verdict and the moment it was
 * observed have to move together.
 */
export interface ProxyCheckWrite {
  readonly health: string;
  readonly latencyMs: number | null;
  readonly checkedAt: string | null;
}

export interface ProxiesRepository {
  create(record: ProxyInsert): ProxyRow;
  listAll(): ProxyRow[];
  findById(id: string): ProxyRow | null;
  /** The stored envelope, for the prober. Never handed to a route. */
  credentialEnvelope(id: string): string | null;
  update(id: string, patch: ProxyPatch, updatedAt: string): void;
  /** Replace the secret without touching anything else. */
  setCredential(id: string, credentialEnvelope: string, updatedAt: string): void;
  recordCheck(id: string, result: ProxyCheckWrite, updatedAt: string): void;
  incrementDispatch(id: string): void;
  delete(id: string): void;
}

export function createProxiesRepository(db: Db): ProxiesRepository {
  return {
    create(record: ProxyInsert): ProxyRow {
      const row = db.insert(proxies).values(record).returning().get();
      if (row === undefined) throw new Error('the inserted proxy could not be read back');
      return row;
    },

    listAll(): ProxyRow[] {
      // Created order, with the id as a tie-break so two proxies pasted in the
      // same millisecond keep a stable place. The console sorts by whatever
      // column the operator picked; this is only the unsorted order.
      return db
        .select()
        .from(proxies)
        .orderBy(asc(proxies.createdAt), asc(proxies.id))
        .all();
    },

    findById(id: string): ProxyRow | null {
      return db.select().from(proxies).where(eq(proxies.id, id)).get() ?? null;
    },

    credentialEnvelope(id: string): string | null {
      const row = db
        .select({ envelope: proxies.credentialEnvelope })
        .from(proxies)
        .where(eq(proxies.id, id))
        .get();
      return row?.envelope ?? null;
    },

    update(id: string, patch: ProxyPatch, updatedAt: string): void {
      const set: Partial<ProxyInsert> = { updatedAt };
      if (patch.protocol !== undefined) set.protocol = patch.protocol;
      if (patch.host !== undefined) set.host = patch.host;
      if (patch.port !== undefined) set.port = patch.port;
      if (patch.note !== undefined) set.note = patch.note;
      db.update(proxies).set(set).where(eq(proxies.id, id)).run();
    },

    setCredential(id: string, credentialEnvelope: string, updatedAt: string): void {
      db.update(proxies)
        .set({ credentialEnvelope, updatedAt })
        .where(eq(proxies.id, id))
        .run();
    },

    recordCheck(id: string, result: ProxyCheckWrite, updatedAt: string): void {
      db.update(proxies)
        .set({
          health: result.health,
          latencyMs: result.latencyMs,
          // Null on a reset, so `untested` and `lastCheckedAt` cannot contradict
          // each other — the page reads the null as "no check has run".
          lastCheckedAt: result.checkedAt,
          updatedAt,
        })
        .where(eq(proxies.id, id))
        .run();
    },

    incrementDispatch(id: string): void {
      db.update(proxies)
        .set({ dispatchCount: sql`${proxies.dispatchCount} + 1` })
        .where(eq(proxies.id, id))
        .run();
    },

    delete(id: string): void {
      db.delete(proxies).where(eq(proxies.id, id)).run();
    },
  };
}
