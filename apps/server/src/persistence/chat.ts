import { asc, desc, eq, sql } from 'drizzle-orm';

import type { Db } from './client.ts';
import { chatMessages, chatSessions } from './schema.ts';

/**
 * Chat sessions and their transcript (C9, FR-7.7).
 *
 * Two lifetimes, two sets of methods. A session is named, re-pointed at a model,
 * and listed; a message is appended and never edited. `appendMessage` takes the
 * next position itself rather than being told one, because the caller has no way
 * to know it — a transcript is appended to by whoever is answering, and two
 * answers landing at once must not both claim the same slot.
 *
 * `touchSession` exists so a turn moves its session to the top of the sidebar
 * without rewriting anything else. The alternative — a whole-row update on every
 * message — would let a concurrent rename be lost to a turn that started before
 * it.
 */

export type ChatSessionRow = typeof chatSessions.$inferSelect;
export type ChatSessionInsert = typeof chatSessions.$inferInsert;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type ChatMessageInsert = typeof chatMessages.$inferInsert;

/** The session fields an operator may edit. */
export interface ChatSessionPatch {
  readonly title?: string | undefined;
  readonly providerId?: string | null | undefined;
  readonly model?: string | null | undefined;
  readonly thinkingLevel?: string | undefined;
  readonly systemPrompt?: string | null | undefined;
}

export interface ChatRepository {
  createSession(record: ChatSessionInsert): ChatSessionRow;
  listSessions(): ChatSessionRow[];
  findSession(id: string): ChatSessionRow | null;
  updateSession(id: string, patch: ChatSessionPatch, updatedAt: string): void;
  /** Move a session to the top of the sidebar without touching anything else. */
  touchSession(id: string, updatedAt: string): void;
  deleteSession(id: string): void;

  messagesOf(sessionId: string): ChatMessageRow[];
  /** Append at the end of the transcript. Returns the row as stored. */
  appendMessage(record: Omit<ChatMessageInsert, 'position'>): ChatMessageRow;
  /** How many messages a session holds, without reading them. */
  countMessages(sessionId: string): number;
  /** The newest message, for the sidebar's preview line. */
  lastMessage(sessionId: string): ChatMessageRow | null;
  /** Delete one message and everything after it (FR-7.8's edit-and-regenerate). */
  truncateFrom(sessionId: string, messageId: string): void;
}

export function createChatRepository(db: Db): ChatRepository {
  return {
    createSession(record: ChatSessionInsert): ChatSessionRow {
      const row = db.insert(chatSessions).values(record).returning().get();
      if (row === undefined) throw new Error('the inserted session could not be read back');
      return row;
    },

    listSessions(): ChatSessionRow[] {
      // Newest activity first: a sidebar is read to find the conversation that
      // just moved.
      return db
        .select()
        .from(chatSessions)
        .orderBy(desc(chatSessions.updatedAt), asc(chatSessions.id))
        .all();
    },

    findSession(id: string): ChatSessionRow | null {
      return db.select().from(chatSessions).where(eq(chatSessions.id, id)).get() ?? null;
    },

    updateSession(id: string, patch: ChatSessionPatch, updatedAt: string): void {
      const set: Partial<ChatSessionInsert> = { updatedAt };
      if (patch.title !== undefined) set.title = patch.title;
      if (patch.providerId !== undefined) set.providerId = patch.providerId;
      if (patch.model !== undefined) set.model = patch.model;
      if (patch.thinkingLevel !== undefined) set.thinkingLevel = patch.thinkingLevel;
      if (patch.systemPrompt !== undefined) set.systemPrompt = patch.systemPrompt;
      db.update(chatSessions).set(set).where(eq(chatSessions.id, id)).run();
    },

    touchSession(id: string, updatedAt: string): void {
      db.update(chatSessions).set({ updatedAt }).where(eq(chatSessions.id, id)).run();
    },

    deleteSession(id: string): void {
      // One transaction: a session without its messages is a sidebar row that
      // opens onto nothing.
      db.transaction((tx) => {
        tx.delete(chatMessages).where(eq(chatMessages.sessionId, id)).run();
        tx.delete(chatSessions).where(eq(chatSessions.id, id)).run();
      });
    },

    messagesOf(sessionId: string): ChatMessageRow[] {
      return db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, sessionId))
        .orderBy(asc(chatMessages.position), asc(chatMessages.id))
        .all();
    },

    appendMessage(record: Omit<ChatMessageInsert, 'position'>): ChatMessageRow {
      // The position is read and the row written inside one transaction, rather
      // than the caller reading a count and passing a number: two turns landing
      // in the same session would otherwise claim the same slot, and a tie in the
      // transcript's order is an order that can flip.
      return db.transaction((tx) => {
        const next =
          tx
            .select({ value: sql<number>`coalesce(max(${chatMessages.position}), -1) + 1` })
            .from(chatMessages)
            .where(eq(chatMessages.sessionId, record.sessionId))
            .get()?.value ?? 0;

        const row = tx
          .insert(chatMessages)
          .values({ ...record, position: next })
          .returning()
          .get();
        if (row === undefined) throw new Error('the appended message could not be read back');
        return row;
      });
    },

    countMessages(sessionId: string): number {
      return (
        db
          .select({ value: sql<number>`count(*)` })
          .from(chatMessages)
          .where(eq(chatMessages.sessionId, sessionId))
          .get()?.value ?? 0
      );
    },

    lastMessage(sessionId: string): ChatMessageRow | null {
      return (
        db
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.sessionId, sessionId))
          .orderBy(desc(chatMessages.position))
          .limit(1)
          .get() ?? null
      );
    },

    truncateFrom(sessionId: string, messageId: string): void {
      const target = db.select().from(chatMessages).where(eq(chatMessages.id, messageId)).get();
      // A message that is not in this session truncates nothing: the caller is
      // asking about a different conversation, and deleting on a guess would take
      // the wrong transcript with it.
      if (target === undefined || target.sessionId !== sessionId) return;
      db.delete(chatMessages)
        .where(
          sql`${chatMessages.sessionId} = ${sessionId} and ${chatMessages.position} >= ${target.position}`,
        )
        .run();
    },
  };
}
