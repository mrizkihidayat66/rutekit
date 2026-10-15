import { z } from 'zod';
import { isoDateTimeSchema } from '../common.ts';

/**
 * API-key controls. The expiry (FR-6.3) and TPS (FR-6.4) fields are the two
 * capabilities no reference project has; they are first-class here.
 */
export const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Display prefix only, e.g. `rk-a1b2`. The secret itself is never returned again. */
  prefix: z.string(),
  /** Empty array means "all models allowed"; a non-empty list is an allowlist. */
  modelsAllowed: z.array(z.string()),
  modelsDenied: z.array(z.string()),
  /** Null means unlimited. */
  budgetRequests: z.number().int().positive().nullable(),
  budgetTokens: z.number().int().positive().nullable(),
  /** Tokens per second ceiling (FR-6.4). Null means unlimited. */
  tpsLimit: z.number().int().positive().nullable(),
  /** Requests per minute ceiling. Null means unlimited. */
  rateLimitPerMinute: z.number().int().positive().nullable(),
  /** Hard expiry (FR-6.3). Null means the key never expires. */
  expiresAt: isoDateTimeSchema.nullable(),
  /** Best-effort client label denylist, matched against a request header (FR-6.6). */
  clientRouterDenylist: z.array(z.string()),
  revokedAt: isoDateTimeSchema.nullable(),
  lastUsedAt: isoDateTimeSchema.nullable(),
  usage: z.object({
    requests: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  createdAt: isoDateTimeSchema,
});

/**
 * Shape returned exactly once, at creation. `secret` is shown in the UI and
 * then discarded — the server stores only a hash (SEC-1).
 */
export const apiKeyCreatedSchema = z.object({
  apiKey: apiKeySchema,
  secret: z.string(),
});

/** Derived lifecycle state shown as a badge in the list. */
export const apiKeyStateSchema = z.enum(['active', 'expired', 'revoked', 'exhausted']);

export function deriveApiKeyState(
  key: z.infer<typeof apiKeySchema>,
  now: Date = new Date(),
): z.infer<typeof apiKeyStateSchema> {
  if (key.revokedAt !== null) return 'revoked';
  if (key.expiresAt !== null && Date.parse(key.expiresAt) <= now.getTime()) return 'expired';
  if (key.budgetRequests !== null && key.usage.requests >= key.budgetRequests) return 'exhausted';
  if (key.budgetTokens !== null) {
    const used = key.usage.inputTokens + key.usage.outputTokens;
    if (used >= key.budgetTokens) return 'exhausted';
  }
  return 'active';
}

export type ApiKey = z.infer<typeof apiKeySchema>;
export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>;
export type ApiKeyState = z.infer<typeof apiKeyStateSchema>;
