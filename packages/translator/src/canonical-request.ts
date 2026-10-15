import { canonicalMessageSchema, textBlockSchema, toolChoiceSchema, toolDefinitionSchema } from '@contracts';
import { z } from 'zod';

/**
 * The pivot request — what every surface is ingested into and rendered out of.
 *
 * The client's own shapes (`chatCompletionRequestSchema` and friends) are wire
 * shapes: they exist so an SDK can be pointed at rutekit, and they carry the
 * field names that SDK expects. This is the shape the rest of the server works
 * in, so routing, the pool and compression never learn a dialect.
 *
 * Three deliberate choices:
 *
 *   - `system` is hoisted out of `messages`, because three of the four surfaces
 *     carry it at the top level and the fourth puts it inline. Hoisting makes
 *     both directions a local decision rather than a scan.
 *   - Sampling fields are nullable rather than optional, so "the client did not
 *     send one" is a value the codecs can act on. A provider that needs a
 *     default gets it from the codec, not from a missing key.
 *   - Anything the pivot does not model is kept verbatim in `extras` rather than
 *     dropped. A parameter rutekit has not learned yet still reaches a provider
 *     that understands it.
 */

export const samplingSchema = z.object({
  temperature: z.number().nullable().default(null),
  topP: z.number().nullable().default(null),
  topK: z.number().int().nullable().default(null),
  maxTokens: z.number().int().positive().nullable().default(null),
  stop: z.array(z.string()).default([]),
  seed: z.number().int().nullable().default(null),
  presencePenalty: z.number().nullable().default(null),
  frequencyPenalty: z.number().nullable().default(null),
});

export type Sampling = z.infer<typeof samplingSchema>;

export const responseFormatSchema = z.object({
  type: z.enum(['text', 'json_object', 'json_schema']),
  jsonSchema: z.record(z.string(), z.unknown()).nullable().default(null),
});

export type ResponseFormat = z.infer<typeof responseFormatSchema>;

export const canonicalRequestSchema = z.object({
  model: z.string(),
  system: z.array(textBlockSchema).default([]),
  messages: z.array(canonicalMessageSchema),
  sampling: samplingSchema.prefault({}),
  tools: z.array(toolDefinitionSchema).default([]),
  toolChoice: toolChoiceSchema.nullable().default(null),
  responseFormat: responseFormatSchema.nullable().default(null),
  stream: z.boolean().default(false),
  extras: z.record(z.string(), z.unknown()).default({}),
});

export type CanonicalRequest = z.infer<typeof canonicalRequestSchema>;
export type CanonicalRequestInput = z.input<typeof canonicalRequestSchema>;
