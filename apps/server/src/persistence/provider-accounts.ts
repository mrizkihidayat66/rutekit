import { and, eq, sql } from 'drizzle-orm';
import type { AccountState } from '@contracts';

import type { Db } from './client.ts';
import { providerAccounts } from './schema.ts';

/**
 * Provider accounts. The credential goes in encrypted and comes back encrypted:
 * this repository never holds a `SecretBox`, because decrypting is a decision
 * about whether a credential is still good, and that belongs to the pool, not to
 * the store.
 *
 * `setCredential` deliberately does not touch `state`. Re-authenticating an
 * account proves the credential is fresh, but it says nothing about why the
 * account left `active` — a `disabled` account is manual-only and never
 * auto-recovers (see `accountSchema`), so a sign-in that silently re-enabled one
 * would break that rule. `setState` is the only writer of `state`, and it is the
 * pool's.
 *
 * The columns added in `0004` split into three groups, and the split is the point:
 * `state`/`stateReason`/`cooldownUntil` are the state machine's, `inFlight` is the
 * pool's mirror of a count it holds in memory, and the `quota*` columns are what a
 * check-in learned. Nothing here decides anything — it stores.
 */

export type ProviderAccountRow = typeof providerAccounts.$inferSelect;
export type ProviderAccountInsert = typeof providerAccounts.$inferInsert;

/** The fields an operator may edit by hand. State moves through `setState`. */
export interface ProviderAccountPatch {
  readonly label?: string | undefined;
  readonly note?: string | null | undefined;
  readonly maxInFlight?: number | undefined;
}

/** What a quota check-in learned about one account (FR-3.6). */
export interface AccountQuotaWrite {
  readonly windowSeconds: number | null;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly resetAt: string | null;
  readonly creditBalance: number | null;
  readonly creditCurrency: string | null;
}

export interface ProviderAccountsRepository {
  /**
   * Insert, and hand back the row as stored.
   *
   * The read-back is not ceremony: the pool's columns carry defaults the caller
   * does not spell out, and a sign-in that returned its own literal would report
   * an `inFlight` and a `quota` block that never came from the database.
   */
  create(record: ProviderAccountInsert): ProviderAccountRow;
  listAll(): ProviderAccountRow[];
  listByProvider(providerId: string): ProviderAccountRow[];
  findById(id: string): ProviderAccountRow | null;
  /**
   * The row a re-sign-in should replace rather than duplicate. Matching on the
   * masked email is the only handle a completed OAuth exchange reliably offers;
   * when a provider returns no email, the flow has nothing to match on and
   * inserts instead.
   */
  findByProviderAndEmail(providerId: string, emailMasked: string): ProviderAccountRow | null;
  setCredential(id: string, credentialEnvelope: string, updatedAt: string): void;
  update(id: string, patch: ProviderAccountPatch, updatedAt: string): void;
  /** The state machine's one write. */
  setState(
    id: string,
    state: AccountState,
    reason: string | null,
    cooldownUntil: string | null,
    updatedAt: string,
  ): void;
  /** The in-flight mirror. `inFlight` is the pool's count, not this table's. */
  setInFlight(id: string, inFlight: number): void;
  /** A turn finished well: stamp the use and clear the failure streak. */
  recordSuccess(id: string, usedAt: string): void;
  /**
   * Forget the failure streak without claiming a turn was served.
   *
   * A warmup check-in proves the credential works but is not a use, so it must
   * not move `lastUsedAt` — the column is what an operator reads to see which
   * account is actually carrying traffic, and a background probe every quarter
   * of an hour would make every account look busy.
   */
  clearFailures(id: string, updatedAt: string): void;
  /** A turn failed: advance the streak. The state machine reads it. */
  recordFailure(id: string, updatedAt: string): void;
  setQuota(id: string, quota: AccountQuotaWrite, updatedAt: string): void;
  delete(id: string): void;
}

export function createProviderAccountsRepository(db: Db): ProviderAccountsRepository {
  return {
    create(record: ProviderAccountInsert): ProviderAccountRow {
      const row = db.insert(providerAccounts).values(record).returning().get();
      if (row === undefined) throw new Error('the inserted account could not be read back');
      return row;
    },

    listAll(): ProviderAccountRow[] {
      return db.select().from(providerAccounts).all();
    },

    listByProvider(providerId: string): ProviderAccountRow[] {
      return db
        .select()
        .from(providerAccounts)
        .where(eq(providerAccounts.providerId, providerId))
        .all();
    },

    findById(id: string): ProviderAccountRow | null {
      return db.select().from(providerAccounts).where(eq(providerAccounts.id, id)).get() ?? null;
    },

    findByProviderAndEmail(providerId: string, emailMasked: string): ProviderAccountRow | null {
      return (
        db
          .select()
          .from(providerAccounts)
          .where(
            and(
              eq(providerAccounts.providerId, providerId),
              eq(providerAccounts.emailMasked, emailMasked),
            ),
          )
          .get() ?? null
      );
    },

    setCredential(id: string, credentialEnvelope: string, updatedAt: string): void {
      db.update(providerAccounts)
        .set({ credentialEnvelope, updatedAt })
        .where(eq(providerAccounts.id, id))
        .run();
    },

    update(id: string, patch: ProviderAccountPatch, updatedAt: string): void {
      const set: Partial<ProviderAccountInsert> = { updatedAt };
      if (patch.label !== undefined) set.label = patch.label;
      if (patch.note !== undefined) set.note = patch.note;
      if (patch.maxInFlight !== undefined) set.maxInFlight = patch.maxInFlight;
      db.update(providerAccounts).set(set).where(eq(providerAccounts.id, id)).run();
    },

    setState(
      id: string,
      state: AccountState,
      reason: string | null,
      cooldownUntil: string | null,
      updatedAt: string,
    ): void {
      db.update(providerAccounts)
        .set({ state, stateReason: reason, cooldownUntil, updatedAt })
        .where(eq(providerAccounts.id, id))
        .run();
    },

    setInFlight(id: string, inFlight: number): void {
      db.update(providerAccounts).set({ inFlight }).where(eq(providerAccounts.id, id)).run();
    },

    recordSuccess(id: string, usedAt: string): void {
      db.update(providerAccounts)
        .set({ consecutiveFailures: 0, lastUsedAt: usedAt, updatedAt: usedAt })
        .where(eq(providerAccounts.id, id))
        .run();
    },

    clearFailures(id: string, updatedAt: string): void {
      db.update(providerAccounts)
        .set({ consecutiveFailures: 0, updatedAt })
        .where(eq(providerAccounts.id, id))
        .run();
    },

    recordFailure(id: string, updatedAt: string): void {
      db.update(providerAccounts)
        .set({
          consecutiveFailures: sql`${providerAccounts.consecutiveFailures} + 1`,
          updatedAt,
        })
        .where(eq(providerAccounts.id, id))
        .run();
    },

    setQuota(id: string, quota: AccountQuotaWrite, updatedAt: string): void {
      db.update(providerAccounts)
        .set({
          quotaWindowSeconds: quota.windowSeconds,
          quotaLimit: quota.limit,
          quotaRemaining: quota.remaining,
          quotaResetAt: quota.resetAt,
          creditBalance: quota.creditBalance,
          creditCurrency: quota.creditCurrency,
          updatedAt,
        })
        .where(eq(providerAccounts.id, id))
        .run();
    },

    delete(id: string): void {
      db.delete(providerAccounts).where(eq(providerAccounts.id, id)).run();
    },
  };
}
