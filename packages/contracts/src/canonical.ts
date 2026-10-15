import { z } from 'zod';

/**
 * The canonical (pivot) shape. Every provider dialect is translated *into* this
 * shape and *out of* it, so the pool, compression and routing layers only ever
 * reason about one representation.
 *
 * OpenAI is the pivot because it is the dialect every client already speaks; the
 * translator handles the rest (PRD FR-1.2).
 */

export const textBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const thinkingBlockSchema = z.object({
  type: z.literal('thinking'),
  text: z.string(),
  /** Provider signature for replaying reasoning turns; null when unsupported. */
  signature: z.string().nullable().default(null),
});

export const imageBlockSchema = z.object({
  type: z.literal('image'),
  /** Media type when known; empty when the client sent a bare URL. */
  mediaType: z.string(),
  /** Base64 payload for an inline image; empty when `url` is set. */
  data: z.string(),
  /**
   * A remote URL, when the client sent one instead of inline bytes.
   *
   * The pivot carries the reference rather than fetching it: whether a URL is
   * acceptable is the provider's decision, and a provider that needs bytes is a
   * routing question (the direct route) rather than a translation one. Dropping
   * the image here would send the provider a request that is quietly missing
   * something the user asked about.
   */
  url: z.string().nullable().default(null),
});

export const toolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

export const toolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  toolUseId: z.string(),
  isError: z.boolean().default(false),
  /** Tool results carry only text and images — never nested tool calls. */
  content: z.array(z.union([textBlockSchema, imageBlockSchema])),
});

export const contentBlockSchema = z.discriminatedUnion('type', [
  textBlockSchema,
  thinkingBlockSchema,
  imageBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
]);

export const contentBlockTypeSchema = z.enum([
  'text',
  'thinking',
  'image',
  'tool_use',
  'tool_result',
]);

export const messageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);

/**
 * Tool definitions are carried through the pivot untouched; each provider
 * adapter renders them in its own dialect.
 */
export const toolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().nullable().default(null),
  parameters: z.record(z.string(), z.unknown()),
});

export const toolChoiceSchema = z.union([
  z.enum(['auto', 'none', 'required']),
  z.object({ type: z.literal('tool'), name: z.string() }),
]);

export const canonicalMessageSchema = z.object({
  role: messageRoleSchema,
  content: z.array(contentBlockSchema),
  /** Optional speaker label; some providers use it for multi-agent turns. */
  name: z.string().nullable().default(null),
  /** Set on `role: 'tool'` messages to link back to the originating call. */
  toolCallId: z.string().nullable().default(null),
});

export const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  reasoningTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative(),
});

export const finishReasonSchema = z.enum([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'error',
  'aborted',
]);

/** The single error shape every surface returns. Never carries a stack trace (R5.9). */
export const errorKindSchema = z.enum([
  'invalid_request',
  'authentication',
  'permission',
  'not_found',
  'rate_limit',
  'quota_exhausted',
  'upstream_error',
  'timeout',
  'unavailable',
  'shutting_down',
  'internal',
  'aborted',
]);

export const apiErrorSchema = z.object({
  kind: errorKindSchema,
  message: z.string(),
  /** Provider id when the failure came from upstream. */
  provider: z.string().nullable().default(null),
  retryAfterSeconds: z.number().nonnegative().nullable().default(null),
  requestId: z.string().nullable().default(null),
});

export type TextBlock = z.infer<typeof textBlockSchema>;
export type ThinkingBlock = z.infer<typeof thinkingBlockSchema>;
export type ImageBlock = z.infer<typeof imageBlockSchema>;
export type ToolUseBlock = z.infer<typeof toolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof toolResultBlockSchema>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type ContentBlockType = z.infer<typeof contentBlockTypeSchema>;
export type MessageRole = z.infer<typeof messageRoleSchema>;
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
export type ToolChoice = z.infer<typeof toolChoiceSchema>;
export type CanonicalMessage = z.infer<typeof canonicalMessageSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type FinishReason = z.infer<typeof finishReasonSchema>;
export type ErrorKind = z.infer<typeof errorKindSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
