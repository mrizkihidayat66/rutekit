import type { ChatMessage, ChatSession, ChatSessionSummary } from '@contracts';
import {
  chatSessionInputSchema,
  chatSessionSchema,
  chatSessionsResponseSchema,
  chatSessionUpdateSchema,
  chatTurnRequestSchema,
} from '@contracts';

import { chatTurn } from '../chat-stream.ts';
import { isoAt } from '../clock.ts';
import { db, matches, paginate, sortBy } from '../db.ts';
import { http } from '../net.ts';
import { sseResponse } from '../sse.ts';
import { bodyOf, listParams, notFound, ok, paramId, respond, route, searchParams, uid } from './helpers.ts';

/**
 * The Chat page, mocked (FR-7.x).
 *
 * Its own domain rather than part of `tools`, even though the nav puts it there:
 * a domain is what goes live at once, and this one's backend landed in C9 while
 * Studio, Benchmark and Verification are still to come (C10–C12). Grouping by nav
 * section would have meant flipping four pages' endpoints together to see one of
 * them work.
 *
 * The turn route is the interesting one. It answers `text/event-stream` rather
 * than a document, because the reply does not exist when the request is answered
 * — it is written onto the response as it is generated. The frames come from
 * `chat-stream.ts`, which emits the AI SDK's UI Message chunks in the order the
 * client requires, so the page is built against the real protocol rather than a
 * stand-in that has to be swapped out when the backend arrives.
 */

function summarizeSession(session: ChatSession): ChatSessionSummary {
  const last = session.messages.at(-1);
  const textBlock = last?.content.find((block) => block.type === 'text');
  const preview = textBlock !== undefined && 'text' in textBlock ? textBlock.text.slice(0, 120) : '';
  return {
    id: session.id,
    title: session.title,
    providerId: session.providerId,
    model: session.model,
    messageCount: session.messages.length,
    preview,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export const chatHandlers = [
  http.get(route('chatSessions'), ({ request }) => {
    const params = searchParams(request);
    const { cursor, limit, sort, direction } = listParams(request);
    const q = params.get('q') ?? '';
    const items = db.chatSessions
      .filter((entry) => matches([entry.title, entry.providerId, entry.model], q))
      .map(summarizeSession);
    return respond(chatSessionsResponseSchema, paginate(sortBy(items, sort, direction), { cursor, limit }));
  }),

  http.post(route('chatSessions'), async ({ request }) => {
    const input = chatSessionInputSchema.parse(await bodyOf(request));
    const session: ChatSession = {
      id: uid('chat'),
      title: input.title,
      providerId: input.providerId,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      systemPrompt: input.systemPrompt,
      messages: [],
      createdAt: isoAt(0),
      updatedAt: isoAt(0),
    };
    db.chatSessions.unshift(session);
    return respond(chatSessionSchema, session);
  }),

  http.get(route('chatSession'), ({ params }) => {
    const session = db.chatSession(paramId(params));
    return session === undefined ? notFound('chat session', paramId(params)) : respond(chatSessionSchema, session);
  }),

  /**
   * Append a turn.
   *
   * The reply is not in the body because it does not exist yet: it is written
   * onto the response as it streams, which is what lets the page paint the first
   * token before the last one has been generated. The frames are AI SDK UI
   * Message chunks over `text/event-stream`, the same protocol the server speaks,
   * so nothing about the page changes when this handler is dropped.
   */
  http.post(route('chatMessages'), async ({ params, request }) => {
    const session = db.chatSession(paramId(params));
    if (session === undefined) return notFound('chat session', paramId(params));
    const input = chatTurnRequestSchema.parse(await bodyOf(request));

    session.messages.push({
      id: uid('msg'),
      role: input.role,
      content: input.content,
      attachments: input.attachments,
      meta: null,
      parentMessageId: input.parentMessageId,
      createdAt: isoAt(0),
    });
    session.updatedAt = isoAt(0);

    const hasImage = input.attachments.some((attachment) => attachment.kind === 'image');
    const prompt = input.content
      .filter((block) => block.type === 'text')
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n');

    const turn = chatTurn({
      prompt,
      hasImage,
      thinkingLevel: input.thinkingLevel,
      providerId: input.providerId ?? session.providerId,
      model: input.model ?? session.model,
      messageId: uid('msg'),
    });

    // The turn becomes part of the session only once it has finished streaming:
    // a reply that was stopped halfway is not a reply, and persisting it at the
    // top would leave the transcript holding an answer the operator never saw.
    return sseResponse(turn.beats, () => {
      const content: ChatMessage['content'] = [];
      if (turn.plan.reasoning !== null) {
        content.push({ type: 'thinking', text: turn.plan.reasoning, signature: null });
      }
      content.push({ type: 'text', text: turn.plan.text });
      if (turn.plan.toolCall !== null) {
        content.push({ type: 'tool_use', id: 'call_1', name: turn.plan.toolCall.name, input: turn.plan.toolCall.input });
      }
      session.messages.push({
        id: uid('msg'),
        role: 'assistant',
        content,
        attachments: [],
        meta: turn.meta,
        parentMessageId: null,
        createdAt: isoAt(0),
      });
      session.updatedAt = isoAt(0);
    });
  }),

  http.patch(route('chatSession'), async ({ params, request }) => {
    const session = db.chatSession(paramId(params));
    if (session === undefined) return notFound('chat session', paramId(params));
    const patch = chatSessionUpdateSchema.parse(await bodyOf(request));
    if (patch.title !== undefined) session.title = patch.title;
    if (patch.providerId !== undefined) session.providerId = patch.providerId;
    if (patch.model !== undefined) session.model = patch.model;
    if (patch.thinkingLevel !== undefined) session.thinkingLevel = patch.thinkingLevel;
    if (patch.systemPrompt !== undefined) session.systemPrompt = patch.systemPrompt;
    session.updatedAt = isoAt(0);
    return respond(chatSessionSchema, session);
  }),

  http.delete(route('chatSession'), ({ params }) => {
    const index = db.chatSessions.findIndex((entry) => entry.id === paramId(params));
    if (index === -1) return notFound('chat session', paramId(params));
    db.chatSessions.splice(index, 1);
    return ok();
  }),
];
