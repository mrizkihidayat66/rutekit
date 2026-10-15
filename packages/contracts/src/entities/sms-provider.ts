import { z } from 'zod';
import { isoDateTimeSchema } from '../common.ts';

/**
 * SMS activation providers (FR-5.6).
 *
 * A `bulk-regist` job creates accounts rather than signing existing ones in, so
 * each account needs a phone number it can receive one code on. That number is
 * rented per attempt from an activation service, which is what this record is:
 * an API key for one such service, plus the last country/operator/product triple
 * it was used with so a registration job can default to something that worked.
 *
 * It is deliberately shaped like a proxy: a small pool of credentials the
 * automation draws from, where one key being out of balance must not stop the
 * batch. `keyHint` is the same write-only convention as everywhere else — the
 * read model returns `first4••••last4` and never the key itself.
 */

/** The activation services rutekit can drive. One for now. */
export const smsProviderKindSchema = z.enum(['5sim']);

export const smsProviderStatusSchema = z.enum(['active', 'disabled', 'error', 'untested']);

export const smsProviderSchema = z.object({
  id: z.string(),
  kind: smsProviderKindSchema,
  /** What the operator calls this key, e.g. "5sim — main". */
  label: z.string(),
  /** Masked credential: `abcd••••wxyz`, or null before the first key was set. */
  keyHint: z.string().nullable(),
  status: smsProviderStatusSchema,
  /** Balance as the service last reported it, in `currency`. */
  balance: z.number().nonnegative().nullable(),
  currency: z.string().nullable(),
  /** The triple the last registration job used, so the form can default to it. */
  country: z.string().nullable(),
  operator: z.string().nullable(),
  product: z.string().nullable(),
  successCount: z.number().int().nonnegative(),
  failCount: z.number().int().nonnegative(),
  lastCheckedAt: isoDateTimeSchema.nullable(),
  note: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type SmsProviderKind = z.infer<typeof smsProviderKindSchema>;
export type SmsProviderStatus = z.infer<typeof smsProviderStatusSchema>;
export type SmsProvider = z.infer<typeof smsProviderSchema>;
