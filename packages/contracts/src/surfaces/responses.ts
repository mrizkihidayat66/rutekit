import { z } from 'zod';
import { openAiUsageSchema } from './common.ts';

/** `/v1/responses` — the OpenAI Responses surface, stateful by `previous_response_id`. */

export const responsesInputItemSchema = z.union([
  z.object({
    type: z.literal('message'),
    role: z.enum(['system', 'developer', 'user', 'assistant']),
    content: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
  }),
  z.object({ type: z.literal('function_call'), call_id: z.string(), name: z.string(), arguments: z.string() }),
  z.object({ type: z.literal('function_call_output'), call_id: z.string(), output: z.string() }),
  z.object({ type: z.literal('reasoning'), id: z.string(), summary: z.array(z.unknown()).optional() }),
]);

export const responsesRequestSchema = z
  .object({
    model: z.string(),
    input: z.union([z.string(), z.array(responsesInputItemSchema)]),
    instructions: z.string().optional(),
    previous_response_id: z.string().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    stream: z.boolean().optional(),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
    tool_choice: z.unknown().optional(),
    text: z.record(z.string(), z.unknown()).optional(),
    store: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown());

export const responsesOutputItemSchema = z.union([
  z.object({
    type: z.literal('message'),
    id: z.string(),
    role: z.literal('assistant'),
    status: z.enum(['in_progress', 'completed', 'incomplete']),
    content: z.array(z.record(z.string(), z.unknown())),
  }),
  z.object({
    type: z.literal('function_call'),
    id: z.string(),
    call_id: z.string(),
    name: z.string(),
    arguments: z.string(),
    status: z.enum(['in_progress', 'completed', 'incomplete']),
  }),
  z.object({
    type: z.literal('reasoning'),
    id: z.string(),
    summary: z.array(z.unknown()),
    status: z.enum(['in_progress', 'completed', 'incomplete']),
  }),
]);

export const responsesResponseSchema = z.object({
  id: z.string(),
  object: z.literal('response'),
  created_at: z.number().int(),
  status: z.enum(['in_progress', 'completed', 'incomplete', 'failed']),
  model: z.string(),
  output: z.array(responsesOutputItemSchema),
  output_text: z.string(),
  usage: openAiUsageSchema.nullable(),
  previous_response_id: z.string().nullable(),
});

export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;
export type ResponsesResponse = z.infer<typeof responsesResponseSchema>;
export type ResponsesOutputItem = z.infer<typeof responsesOutputItemSchema>;
