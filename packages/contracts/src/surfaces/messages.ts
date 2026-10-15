import { z } from 'zod';

/**
 * `/v1/messages` — the Anthropic dialect. Kept as its own surface because
 * Claude clients depend on details the OpenAI pivot cannot express losslessly,
 * notably the ordering of `message_start` and thinking blocks (FR-1.7, R5.6).
 */

export const anthropicContentBlockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), source: z.record(z.string(), z.unknown()) }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.unknown().optional(),
    is_error: z.boolean().optional(),
  }),
  z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string().optional() }),
]);

export const anthropicMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(anthropicContentBlockSchema)]),
});

export const messagesRequestSchema = z
  .object({
    model: z.string(),
    messages: z.array(anthropicMessageSchema).min(1),
    system: z.union([z.string(), z.array(anthropicContentBlockSchema)]).optional(),
    max_tokens: z.number().int().positive(),
    temperature: z.number().min(0).max(1).optional(),
    top_p: z.number().min(0).max(1).optional(),
    top_k: z.number().int().optional(),
    stop_sequences: z.array(z.string()).optional(),
    stream: z.boolean().optional(),
    metadata: z.object({ user_id: z.string().optional() }).optional(),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
    tool_choice: z.record(z.string(), z.unknown()).optional(),
    thinking: z
      .object({ type: z.literal('enabled'), budget_tokens: z.number().int().positive() })
      .optional(),
  })
  .catchall(z.unknown());

export const anthropicUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
});

export const messagesResponseSchema = z.object({
  id: z.string(),
  type: z.literal('message'),
  role: z.literal('assistant'),
  model: z.string(),
  content: z.array(anthropicContentBlockSchema),
  stop_reason: z.enum(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use']).nullable(),
  stop_sequence: z.string().nullable(),
  usage: anthropicUsageSchema,
});

/**
 * The SSE event vocabulary. `message_start` must be the first event emitted for
 * every streamed response — clients rely on it to allocate the message.
 */
export const messagesStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message_start'),
    message: z.object({
      id: z.string(),
      type: z.literal('message'),
      role: z.literal('assistant'),
      model: z.string(),
      content: z.array(z.unknown()),
      stop_reason: z.null(),
      stop_sequence: z.null(),
      usage: anthropicUsageSchema,
    }),
  }),
  z.object({
    type: z.literal('content_block_start'),
    index: z.number().int().nonnegative(),
    content_block: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('content_block_delta'),
    index: z.number().int().nonnegative(),
    delta: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('content_block_stop'),
    index: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('message_delta'),
    delta: z.object({
      stop_reason: z.enum(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use']).nullable(),
      stop_sequence: z.string().nullable(),
    }),
    usage: z.object({ output_tokens: z.number().int().nonnegative() }),
  }),
  z.object({ type: z.literal('message_stop') }),
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('error'), error: z.record(z.string(), z.unknown()) }),
]);

export type MessagesRequest = z.infer<typeof messagesRequestSchema>;
export type MessagesResponse = z.infer<typeof messagesResponseSchema>;
export type MessagesStreamEvent = z.infer<typeof messagesStreamEventSchema>;
export type AnthropicUsage = z.infer<typeof anthropicUsageSchema>;
