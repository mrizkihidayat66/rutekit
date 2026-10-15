import { eq, sql } from 'drizzle-orm';

import type { Db } from './client.ts';
import { apiKeys } from './schema.ts';

/**
 * API keys (FR-6). The row keeps the SHA-256 of the key, never the key itself
 * (R5.10), so the only way to present one is to still hold it.
 *
 * Usage counters are incremented in SQL rather than read-modify-written in
 * JavaScript: two concurrent requests on the same key are exactly the case this
 * table exists for, and a read-then-write would lose one of the increments.
 *
 * `listAll` returns every row with no ordering, and the service does the
 * filtering, sorting and paging. That is deliberate: a key's lifecycle state is
 * *derived* (expiry and budget are compared against the clock and the usage
 * counters), so a `where` clause could not express the filter the console
 * offers, and reimplementing the derivation in SQL would be a second source of
 * truth. An instance holds tens of keys, not millions.
 */

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ApiKeyInsert = typeof apiKeys.$inferInsert;

/**
 * Absent key = leave unchanged; `null` = clear the ceiling (unlimited).
 *
 * `| undefined` on each field is not decoration: the console sends a partial
 * body, and under `exactOptionalPropertyTypes` a `{ name?: string }` cannot be
 * assigned from the contract's `{ name?: string | undefined }`. Widening here
 * says what the implementation already does — an explicit `undefined` is the
 * same as an absent key.
 */
export interface ApiKeyUpdate {
  readonly name?: string | undefined;
  readonly modelsAllowed?: readonly string[] | undefined;
  readonly modelsDenied?: readonly string[] | undefined;
  readonly budgetRequests?: number | null | undefined;
  readonly budgetTokens?: number | null | undefined;
  readonly tpsLimit?: number | null | undefined;
  readonly rateLimitPerMinute?: number | null | undefined;
  readonly expiresAt?: string | null | undefined;
  readonly clientRouterDenylist?: readonly string[] | undefined;
}

export interface UsageDelta {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ApiKeysRepository {
  create(record: ApiKeyInsert): void;
  listAll(): ApiKeyRow[];
  count(): number;
  findById(id: string): ApiKeyRow | null;
  findBySecretHash(secretHash: string): ApiKeyRow | null;
  update(id: string, patch: ApiKeyUpdate): void;
  revoke(id: string, revokedAt: string): void;
  recordUsage(id: string, delta: UsageDelta, lastUsedAt: string): void;
  delete(id: string): void;
}

export function createApiKeysRepository(db: Db): ApiKeysRepository {
  return {
    create(record: ApiKeyInsert): void {
      db.insert(apiKeys).values(record).run();
    },

    listAll(): ApiKeyRow[] {
      return db.select().from(apiKeys).all();
    },

    count(): number {
      return db.select({ value: sql<number>`count(*)` }).from(apiKeys).get()?.value ?? 0;
    },

    findById(id: string): ApiKeyRow | null {
      return db.select().from(apiKeys).where(eq(apiKeys.id, id)).get() ?? null;
    },

    findBySecretHash(secretHash: string): ApiKeyRow | null {
      return db.select().from(apiKeys).where(eq(apiKeys.secretHash, secretHash)).get() ?? null;
    },

    update(id: string, patch: ApiKeyUpdate): void {
      const set: Partial<ApiKeyInsert> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.modelsAllowed !== undefined) set.modelsAllowed = [...patch.modelsAllowed];
      if (patch.modelsDenied !== undefined) set.modelsDenied = [...patch.modelsDenied];
      if (patch.budgetRequests !== undefined) set.budgetRequests = patch.budgetRequests;
      if (patch.budgetTokens !== undefined) set.budgetTokens = patch.budgetTokens;
      if (patch.tpsLimit !== undefined) set.tpsLimit = patch.tpsLimit;
      if (patch.rateLimitPerMinute !== undefined) set.rateLimitPerMinute = patch.rateLimitPerMinute;
      if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt;
      if (patch.clientRouterDenylist !== undefined) {
        set.clientRouterDenylist = [...patch.clientRouterDenylist];
      }
      if (Object.keys(set).length === 0) return;
      db.update(apiKeys).set(set).where(eq(apiKeys.id, id)).run();
    },

    revoke(id: string, revokedAt: string): void {
      db.update(apiKeys).set({ revokedAt }).where(eq(apiKeys.id, id)).run();
    },

    recordUsage(id: string, delta: UsageDelta, lastUsedAt: string): void {
      db.update(apiKeys)
        .set({
          usageRequests: sql`${apiKeys.usageRequests} + ${delta.requests}`,
          usageInputTokens: sql`${apiKeys.usageInputTokens} + ${delta.inputTokens}`,
          usageOutputTokens: sql`${apiKeys.usageOutputTokens} + ${delta.outputTokens}`,
          lastUsedAt,
        })
        .where(eq(apiKeys.id, id))
        .run();
    },

    delete(id: string): void {
      db.delete(apiKeys).where(eq(apiKeys.id, id)).run();
    },
  };
}
