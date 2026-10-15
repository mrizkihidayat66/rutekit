import { z } from 'zod';
import { isoDateTimeSchema, slugSchema } from '../common.ts';

/**
 * The seven legal states (FR-3.1). Transitions between them are fixed by the
 * pool state machine and may not be extended without an ADR (CONTRIBUTING §5.3).
 *
 *   active → rate_limited | exhausted | error | disabled
 *   rate_limited → active (TTL expiry)
 *   exhausted → active (quota reset)
 *   error → active (warmup / successful retry)
 *   disabled → (manual only; never auto-recovers)
 */
export const accountStateSchema = z.enum([
  'active',
  'banned',
  'disabled',
  'exhausted',
  'error',
  'pending',
  'rate_limited',
]);

export const accountQuotaSchema = z.object({
  /** Window the quota resets on, in seconds. Null when unknown. */
  windowSeconds: z.number().int().positive().nullable(),
  limit: z.number().nonnegative().nullable(),
  remaining: z.number().nonnegative().nullable(),
  resetAt: isoDateTimeSchema.nullable(),
  /** Set when the provider reports credit balance instead of request counts. */
  creditBalance: z.number().nullable().default(null),
  creditCurrency: z.string().nullable().default(null),
});

export const accountSchema = z.object({
  id: z.string(),
  providerId: slugSchema,
  /** Operator-facing label; falls back to a masked email when unset. */
  label: z.string(),
  /** Always masked in transit — never the raw credential. */
  emailMasked: z.string().nullable(),
  state: accountStateSchema,
  /** Why the account left `active`, in operator language. */
  stateReason: z.string().nullable(),
  inFlight: z.number().int().nonnegative(),
  maxInFlight: z.number().int().positive(),
  /** Set while `state` is `rate_limited` or `exhausted`. */
  cooldownUntil: isoDateTimeSchema.nullable(),
  quota: accountQuotaSchema,
  /** Consecutive failures; resets on success. Drives backoff. */
  consecutiveFailures: z.number().int().nonnegative(),
  lastUsedAt: isoDateTimeSchema.nullable(),
  note: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type AccountState = z.infer<typeof accountStateSchema>;
export type AccountQuota = z.infer<typeof accountQuotaSchema>;
export type Account = z.infer<typeof accountSchema>;

/** States that routing may select from. `disabled` is a hard exclusion (R5.4). */
export const ROUTABLE_ACCOUNT_STATES: readonly AccountState[] = ['active'];

/** States an operator can act on from the Accounts page. */
export const RECOVERABLE_ACCOUNT_STATES: readonly AccountState[] = [
  'banned',
  'error',
  'exhausted',
  'rate_limited',
];
