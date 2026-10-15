import { apiErrorSchema, contentBlockSchema, finishReasonSchema, usageSchema } from '@contracts';
import { z } from 'zod';

/**
 * The pivot's stream vocabulary.
 *
 * One vocabulary for every provider, because the alternative is every surface
 * renderer learning every provider's chunk shape. A codec turns its wire family
 * into these events; a renderer turns these events into its surface's frames. The
 * two halves never meet, which is what keeps four surfaces times three wire
 * families from becoming twelve translators.
 *
 * `start` carries optional usage because providers differ on when they know it:
 * Anthropic reports `input_tokens` in its opening frame, OpenAI reports nothing
 * until the stream is over. A surface that needs the number early — Anthropic's
 * own `message_start` does — reads it here and falls back to zero.
 *
 * The block events mirror Anthropic's `content_block_*` triple rather than
 * OpenAI's flattened deltas, because the richer shape is the one that survives
 * the round trip: a text delta can be derived from it, but an interleaved
 * thinking-then-text-then-tool sequence cannot be recovered from flat deltas.
 */
export const canonicalStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    id: z.string(),
    model: z.string(),
    created: z.number().int(),
    usage: usageSchema.nullable().default(null),
  }),
  z.object({
    type: z.literal('block_start'),
    index: z.number().int().nonnegative(),
    block: contentBlockSchema,
  }),
  z.object({
    type: z.literal('text_delta'),
    index: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('thinking_delta'),
    index: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('input_json_delta'),
    index: z.number().int().nonnegative(),
    partialJson: z.string(),
  }),
  z.object({
    type: z.literal('block_stop'),
    index: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('finish'),
    finishReason: finishReasonSchema,
    usage: usageSchema,
  }),
  z.object({ type: z.literal('error'), error: apiErrorSchema }),
  z.object({ type: z.literal('ping') }),
]);

export type CanonicalStreamEvent = z.infer<typeof canonicalStreamEventSchema>;
