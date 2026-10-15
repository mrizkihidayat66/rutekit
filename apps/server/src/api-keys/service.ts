import type { ApiKey, ApiKeyCreated, ApiKeyInput, ApiKeyUpdate, ApiKeysQuery, ApiKeysResponse } from '@contracts';
import { deriveApiKeyState } from '@contracts';

import { AppError } from '@server/errors.ts';
import type { ApiKeyRow, ApiKeysRepository, UsageDelta } from '@server/persistence/api-keys.ts';
import { hashToken, mintApiKey } from '@server/security/tokens.ts';

/**
 * API keys (FR-6).
 *
 * The secret is minted here and returned exactly once — the create response is
 * the only place it ever appears, and what the database keeps is its SHA-256
 * (R5.10). Everything the console later shows comes from the stored row: the
 * display prefix, the scope lists, the ceilings, and the usage counters.
 *
 * The lifecycle state is not stored. `deriveApiKeyState` from the contract is
 * the one derivation, shared with the console, so a key the UI paints as
 * "expired" is expired to the guard that refuses it for the same reason at the
 * same moment.
 */

/** What the console sends when it creates a key. Absent optional fields take the contract's default. */
export type ApiKeyCreateInput = ApiKeyInput;

export interface ApiKeyService {
  list(query: ApiKeysQuery): ApiKeysResponse;
  create(input: ApiKeyCreateInput): ApiKeyCreated;
  update(id: string, patch: ApiKeyUpdate): ApiKey;
  revoke(id: string): ApiKey;
  remove(id: string): void;
  /** The row behind a presented secret, or `null`. The caller judges its state. */
  findBySecret(secret: string): ApiKeyRow | null;
  /**
   * The row behind an id, or `null`.
   *
   * The `/v1` guard puts the id on the context, and the dispatcher needs the
   * row's scope lists back to decide whether the requested model is in range —
   * a check the guard cannot make, because it runs before the body is read.
   */
  findById(id: string): ApiKeyRow | null;
  recordUsage(id: string, delta: UsageDelta): void;
}

export interface ApiKeyServiceDeps {
  readonly apiKeys: ApiKeysRepository;
  readonly now?: () => Date;
}

/** Sort keys the console offers, mapped to the column each one orders by. */
const SORTERS: Record<string, (row: ApiKeyRow) => string> = {
  name: (row) => row.name.toLowerCase(),
  createdAt: (row) => row.createdAt,
  expiresAt: (row) => row.expiresAt ?? '',
  lastUsedAt: (row) => row.lastUsedAt ?? '',
};

/** The stored row as the console's contract. Exported because the guard judges state through it too. */
export function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    modelsAllowed: row.modelsAllowed,
    modelsDenied: row.modelsDenied,
    budgetRequests: row.budgetRequests,
    budgetTokens: row.budgetTokens,
    tpsLimit: row.tpsLimit,
    rateLimitPerMinute: row.rateLimitPerMinute,
    expiresAt: row.expiresAt,
    clientRouterDenylist: row.clientRouterDenylist,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    usage: {
      requests: row.usageRequests,
      inputTokens: row.usageInputTokens,
      outputTokens: row.usageOutputTokens,
    },
    createdAt: row.createdAt,
  };
}

/** Cursors are plain offsets, matching what the console's pager already sends. */
function offsetOf(cursor: string | null): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function createApiKeyService(deps: ApiKeyServiceDeps): ApiKeyService {
  const now = deps.now ?? ((): Date => new Date());

  function requireRow(id: string): ApiKeyRow {
    const row = deps.apiKeys.findById(id);
    if (row === null) throw AppError.notFound(`No API key with id ${id}.`);
    return row;
  }

  return {
    list(query: ApiKeysQuery): ApiKeysResponse {
      const at = now();
      const needle = query.q.trim().toLowerCase();

      let rows = deps.apiKeys.listAll();
      if (needle !== '') {
        rows = rows.filter(
          (row) =>
            row.name.toLowerCase().includes(needle) || row.prefix.toLowerCase().includes(needle),
        );
      }
      if (query.state !== null) {
        rows = rows.filter((row) => deriveApiKeyState(toApiKey(row), at) === query.state);
      }

      const sortBy = SORTERS[query.sort ?? 'createdAt'] ?? SORTERS.createdAt;
      const direction = query.direction === 'asc' ? 1 : -1;
      const sorted = [...rows].sort((a, b) => {
        const left = sortBy?.(a) ?? '';
        const right = sortBy?.(b) ?? '';
        if (left === right) return a.id.localeCompare(b.id);
        return left < right ? -direction : direction;
      });

      const offset = offsetOf(query.cursor);
      const items = sorted.slice(offset, offset + query.limit).map(toApiKey);
      const next = offset + query.limit;
      return {
        items,
        nextCursor: next < sorted.length ? String(next) : null,
        total: sorted.length,
      };
    },

    create(input: ApiKeyCreateInput): ApiKeyCreated {
      const { secret, prefix, hash } = mintApiKey();
      const row: ApiKeyRow = {
        id: crypto.randomUUID(),
        name: input.name,
        prefix,
        secretHash: hash,
        modelsAllowed: [...input.modelsAllowed],
        modelsDenied: [...input.modelsDenied],
        budgetRequests: input.budgetRequests,
        budgetTokens: input.budgetTokens,
        tpsLimit: input.tpsLimit,
        rateLimitPerMinute: input.rateLimitPerMinute,
        expiresAt: input.expiresAt,
        clientRouterDenylist: [...input.clientRouterDenylist],
        createdBy: null,
        revokedAt: null,
        lastUsedAt: null,
        usageRequests: 0,
        usageInputTokens: 0,
        usageOutputTokens: 0,
        createdAt: now().toISOString(),
      };
      deps.apiKeys.create(row);
      // The one and only time the secret is in a response.
      return { apiKey: toApiKey(row), secret };
    },

    update(id: string, patch: ApiKeyUpdate): ApiKey {
      requireRow(id);
      deps.apiKeys.update(id, patch);
      return toApiKey(requireRow(id));
    },

    revoke(id: string): ApiKey {
      requireRow(id);
      deps.apiKeys.revoke(id, now().toISOString());
      return toApiKey(requireRow(id));
    },

    remove(id: string): void {
      requireRow(id);
      deps.apiKeys.delete(id);
    },

    findBySecret(secret: string): ApiKeyRow | null {
      if (secret === '') return null;
      return deps.apiKeys.findBySecretHash(hashToken(secret));
    },

    findById(id: string): ApiKeyRow | null {
      return deps.apiKeys.findById(id);
    },

    recordUsage(id: string, delta: UsageDelta): void {
      deps.apiKeys.recordUsage(id, delta, now().toISOString());
    },
  };
}
