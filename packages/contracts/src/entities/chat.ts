import { z } from 'zod';
import { contentBlockSchema, finishReasonSchema, usageSchema } from '../canonical.ts';
import { isoDateTimeSchema } from '../common.ts';

/** Reasoning effort levels exposed in the chat header (FR-7.10). */
export const thinkingLevelSchema = z.enum(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);

export const chatAttachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(['image', 'text']),
  name: z.string(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  /** Data URL for images, inline text for text attachments. */
  data: z.string(),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
});

/** Timing metadata shown under each assistant turn (FR-7.9). */
export const chatMessageMetaSchema = z.object({
  ttftMs: z.number().nonnegative().nullable(),
  totalMs: z.number().nonnegative().nullable(),
  tokensPerSecond: z.number().nonnegative().nullable(),
  usage: usageSchema.nullable(),
  finishReason: finishReasonSchema.nullable(),
  /** Which provider/model actually served the turn. */
  providerId: z.string().nullable(),
  model: z.string().nullable(),
});

export const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.array(contentBlockSchema),
  attachments: z.array(chatAttachmentSchema).default([]),
  meta: chatMessageMetaSchema.nullable().default(null),
  /** Set when this turn was branched from another message (FR-7.8). */
  parentMessageId: z.string().nullable().default(null),
  createdAt: isoDateTimeSchema,
});

export const chatSessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  thinkingLevel: thinkingLevelSchema,
  systemPrompt: z.string().nullable(),
  messages: z.array(chatMessageSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

/** Trimmed session row for the sidebar list, without message bodies. */
export const chatSessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  messageCount: z.number().int().nonnegative(),
  preview: z.string(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export type ChatAttachment = z.infer<typeof chatAttachmentSchema>;
export type ChatMessageMeta = z.infer<typeof chatMessageMetaSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatSession = z.infer<typeof chatSessionSchema>;
export type ChatSessionSummary = z.infer<typeof chatSessionSummarySchema>;
