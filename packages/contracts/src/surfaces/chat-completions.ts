import { z } from 'zod';
import { openAiUsageSchema, samplingFields } from './common.ts';

/** `/v1/chat/completions` — the surface every OpenAI-compatible client speaks. */

export const chatCompletionContentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({ url: z.string(), detail: z.enum(['auto', 'low', 'high']).optional() }),
  }),
]);

export const chatCompletionMessageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  /**
   * A string for simple turns, an array when multimodal parts are present.
   * Absent as well as null on an assistant turn that only calls tools: the SDKs
   * differ on which of the two they emit, and a router that accepts only one of
   * them rejects a request the upstream would have served.
   */
  content: z.union([z.string(), z.array(chatCompletionContentPartSchema)]).nullable().optional(),
  name: z.string().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({ name: z.string(), arguments: z.string() }),
      }),
    )
    .optional(),
  tool_call_id: z.string().optional(),
});

export const chatCompletionRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(chatCompletionMessageSchema).min(1),
    ...samplingFields,
    n: z.number().int().positive().optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    logit_bias: z.record(z.string(), z.number()).optional(),
    user: z.string().optional(),
    response_format: z
      .object({
        type: z.enum(['text', 'json_object', 'json_schema']),
        json_schema: z.record(z.string(), z.unknown()).optional(),
      })
      .optional(),
    tools: z
      .array(
        z.object({
          type: z.literal('function'),
          function: z.object({
            name: z.string(),
            description: z.string().optional(),
            parameters: z.record(z.string(), z.unknown()).optional(),
          }),
        }),
      )
      .optional(),
    tool_choice: z
      .union([
        z.enum(['auto', 'none', 'required']),
        z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) }),
      ])
      .optional(),
  })
  .catchall(z.unknown());

export const chatCompletionChoiceSchema = z.object({
  index: z.number().int().nonnegative(),
  message: z.object({
    role: z.literal('assistant'),
    content: z.string().nullable(),
    /** Non-standard but widely emitted by reasoning models. */
    reasoning_content: z.string().optional(),
    tool_calls: z
      .array(
        z.object({
          id: z.string(),
          type: z.literal('function'),
          function: z.object({ name: z.string(), arguments: z.string() }),
        }),
      )
      .optional(),
  }),
  finish_reason: z.enum(['stop', 'length', 'tool_calls', 'content_filter']).nullable(),
});

export const chatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion'),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(chatCompletionChoiceSchema),
  usage: openAiUsageSchema.optional(),
});

/** One SSE chunk. `[DONE]` is sent as a bare sentinel, not a JSON object. */
export const chatCompletionChunkSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion.chunk'),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      delta: z.object({
        role: z.literal('assistant').optional(),
        content: z.string().optional(),
        reasoning_content: z.string().optional(),
        tool_calls: z
          .array(
            z.object({
              index: z.number().int().nonnegative(),
              id: z.string().optional(),
              type: z.literal('function').optional(),
              function: z.object({ name: z.string().optional(), arguments: z.string().optional() }),
            }),
          )
          .optional(),
      }),
      finish_reason: z.enum(['stop', 'length', 'tool_calls', 'content_filter']).nullable(),
    }),
  ),
  usage: openAiUsageSchema.nullable().optional(),
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type ChatCompletionResponse = z.infer<typeof chatCompletionResponseSchema>;
export type ChatCompletionChunk = z.infer<typeof chatCompletionChunkSchema>;
