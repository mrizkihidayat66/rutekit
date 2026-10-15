import { z } from 'zod';

/** `/v1/models` — the catalogue clients discover against. */

export const modelObjectSchema = z.object({
  id: z.string(),
  object: z.literal('model'),
  created: z.number().int(),
  owned_by: z.string(),
  /** rutekit extensions: which provider serves it and what it can do. */
  rutekit: z
    .object({
      providerId: z.string(),
      alias: z.string().nullable(),
      contextWindow: z.number().int().positive().nullable(),
      capabilities: z.object({
        vision: z.boolean(),
        tools: z.boolean(),
        reasoning: z.boolean(),
        embedding: z.boolean(),
      }),
    })
    .optional(),
});

export const modelsResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(modelObjectSchema),
});

export type ModelObject = z.infer<typeof modelObjectSchema>;
export type ModelsResponse = z.infer<typeof modelsResponseSchema>;
