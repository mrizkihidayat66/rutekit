import { z } from 'zod';
import { openAiUsageSchema, samplingFields } from './common.ts';

/**
 * `/v1/completions` — the legacy text-completion surface. Kept because older
 * coding tools and FIM (fill-in-the-middle) clients still call it.
 */

export const completionRequestSchema = z
  .object({
    model: z.string(),
    prompt: z.union([z.string(), z.array(z.string())]),
    ...samplingFields,
    n: z.number().int().positive().optional(),
    best_of: z.number().int().positive().optional(),
    suffix: z.string().optional(),
    echo: z.boolean().optional(),
    logprobs: z.number().int().optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    user: z.string().optional(),
  })
  .catchall(z.unknown());

export const completionChoiceSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string(),
  finish_reason: z.enum(['stop', 'length', 'content_filter']).nullable(),
});

export const completionResponseSchema = z.object({
  id: z.string(),
  object: z.literal('text_completion'),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(completionChoiceSchema),
  usage: openAiUsageSchema.optional(),
});

export type CompletionRequest = z.infer<typeof completionRequestSchema>;
export type CompletionResponse = z.infer<typeof completionResponseSchema>;
