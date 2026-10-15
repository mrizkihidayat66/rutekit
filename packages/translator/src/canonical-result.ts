import { canonicalMessageSchema, finishReasonSchema, usageSchema } from '@contracts';
import { z } from 'zod';

/**
 * What a provider answered, in the pivot's terms.
 *
 * The mirror of `CanonicalRequest`: a provider codec decodes its own wire family
 * into this and the surface renderers encode it back out, so neither half has to
 * know the other's dialect.
 *
 * One assistant turn rather than a list of choices. The pivot describes one
 * conversation, and `n > 1` is a request for several independent ones; a client
 * that asked for that belongs on the direct route. Faking it here by keeping only
 * the first choice would be a silent truncation.
 *
 * `created` is required rather than filled in here: a clock is a side effect, and
 * this package has none. The codec that owns the socket supplies it.
 */
export const canonicalResultSchema = z.object({
  id: z.string(),
  model: z.string(),
  /** Unix seconds. */
  created: z.number().int(),
  message: canonicalMessageSchema,
  finishReason: finishReasonSchema,
  usage: usageSchema,
});

export type CanonicalResult = z.infer<typeof canonicalResultSchema>;
