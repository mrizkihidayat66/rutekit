import { z } from 'zod';
import type { usageSchema } from '../canonical.ts';

/**
 * Fields every surface shares. Provider-specific extras are preserved rather
 * than dropped: `.catchall()` keeps unknown keys so a BYOK endpoint can receive
 * parameters rutekit does not model yet.
 */
export const samplingFields = {
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  seed: z.number().int().optional(),
  stream: z.boolean().optional(),
};

/** Usage in the flat shape OpenAI-compatible clients expect. */
export const openAiUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  prompt_tokens_details: z
    .object({ cached_tokens: z.number().int().nonnegative().default(0) })
    .optional(),
  completion_tokens_details: z
    .object({ reasoning_tokens: z.number().int().nonnegative().default(0) })
    .optional(),
});

export type OpenAiUsage = z.infer<typeof openAiUsageSchema>;

/** Translate the canonical usage into the OpenAI flat shape. */
export function toOpenAiUsage(usage: z.infer<typeof usageSchema>): OpenAiUsage {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: { cached_tokens: usage.cachedInputTokens },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens },
  };
}

/**
 * Error envelope for the `/v1/*` surfaces, matching the OpenAI error shape so
 * existing SDKs surface the message without special-casing.
 */
export const openAiErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    code: z.string().nullable(),
    param: z.string().nullable().default(null),
  }),
});
export type OpenAiError = z.infer<typeof openAiErrorSchema>;
