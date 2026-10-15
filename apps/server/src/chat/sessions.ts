import type {
  ChatMessage,
  ChatMessageInput,
  ChatMessageMeta,
  ChatSession,
  ChatSessionInput,
  ChatSessionSummary,
  ChatSessionUpdate,
  ChatSessionsQuery,
  ChatSessionsResponse,
} from '@contracts';
import { chatAttachmentSchema, chatMessageMetaSchema, contentBlockSchema, thinkingLevelSchema } from '@contracts';

import { AppError } from '@server/errors.ts';
import type {
  ChatMessageRow,
  ChatRepository,
  ChatSessionRow,
} from '@server/persistence/chat.ts';

/**
 * Conversations on the console (C9, FR-7.7).
 *
 * A session is a title, the three routing choices, and a transcript that is only
 * ever appended to. The interesting decisions are all about the transcript, so
 * they are worth stating once here rather than in each method.
 *
 * **The transcript is the server's, not the client's.** The console sends one
 * turn — what the operator just typed, and what they just dropped onto it — and
 * the conversation it belongs to comes from these rows. That is what makes a
 * resumed chat identical to one that never left the page, and it is why a turn's
 * request body stays small no matter how long the conversation is.
 *
 * **The stored shape is the contract's shape.** `content` and `attachments` are
 * the same arrays the console reads, so a turn read back is a turn the page
 * already knows how to render and the pivot already knows how to send. Nothing is
 * mapped on the way in or out except the fields the row stores differently — the
 * timestamps, the position, and the role's own vocabulary.
 *
 * **Everything read back is checked against the contract.** The columns are
 * typed in Drizzle, but that type is an assertion the driver cannot enforce, and
 * this is the one place a shape the contract no longer accepts can be caught: the
 * content a provider's answer folded into is what the *next* turn sends back to a
 * provider, so a bad block is worth failing on rather than forwarding. `get` and
 * `transcript` refuse and name the message. `list` does not — a sidebar is how an
 * operator finds the conversation that has the problem, and one unreadable row
 * must not take the whole list down with it.
 */

/** One conversation, and its transcript. */
export interface ChatService {
  list(query: ChatSessionsQuery): ChatSessionsResponse;
  create(input: ChatSessionInput): ChatSession;
  get(id: string): ChatSession;
  update(id: string, patch: ChatSessionUpdate): ChatSession;
  remove(id: string): void;

  /** The stored transcript, oldest first. What a turn sends to the model. */
  transcript(id: string): readonly ChatMessage[];
  /**
   * Append one turn, and move its session to the top of the sidebar.
   *
   * `meta` is given only for a reply the server produced: what a turn cost is
   * known by the time its stream has ended, and the row is written once rather
   * than inserted blank and filled in a moment later.
   */
  append(id: string, input: ChatMessageInput, meta?: ChatMessageMeta | null): ChatMessage;

  /** The whole conversation as Markdown (FR-7.7). */
  exportMarkdown(id: string): { readonly filename: string; readonly body: string };
}

export interface ChatServiceDeps {
  readonly sessions: ChatRepository;
  readonly now?: () => Date;
  /** Injectable so a test can assert the ids rutekit mints. */
  readonly newId?: () => string;
}

/** The preview a sidebar row shows: the first text block of the newest turn. */
const PREVIEW_CHARS = 120;

/** A title's contribution to a filename: enough to recognise, never a path. */
const FILENAME_CHARS = 60;

export function createChatService(deps: ChatServiceDeps): ChatService {
  const now = deps.now ?? ((): Date => new Date());
  const newId = deps.newId ?? ((): string => crypto.randomUUID());

  function requireSession(id: string): ChatSessionRow {
    const row = deps.sessions.findSession(id);
    if (row === null) throw AppError.notFound(`No chat session with id ${id}.`);
    return row;
  }

  /** Every stored turn, as the contract reads them. Refuses on a row it cannot parse. */
  function messagesOf(sessionId: string): ChatMessage[] {
    return deps.sessions.messagesOf(sessionId).map((row) => toChatMessage(sessionId, row));
  }

  return {
    list(query: ChatSessionsQuery): ChatSessionsResponse {
      const needle = query.q.trim().toLowerCase();
      // The repository already orders by newest activity, which is the order a
      // sidebar is read in — so an absent `sort` keeps it.
      let rows = deps.sessions.listSessions();
      if (needle !== '') {
        rows = rows.filter((row) =>
          [row.title, row.providerId ?? '', row.model ?? ''].some((value) =>
            value.toLowerCase().includes(needle),
          ),
        );
      }

      const summaries = rows.map((row) => summarize(row, deps));
      const sorted = sortRows(summaries, query);
      const offset = offsetOf(query.cursor);
      const next = offset + query.limit;
      return {
        items: sorted.slice(offset, next),
        nextCursor: next < sorted.length ? String(next) : null,
        total: sorted.length,
      };
    },

    create(input: ChatSessionInput): ChatSession {
      const at = now().toISOString();
      const row = deps.sessions.createSession({
        id: newId(),
        title: input.title,
        providerId: input.providerId,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        systemPrompt: input.systemPrompt,
        createdAt: at,
        updatedAt: at,
      });
      return toChatSession(row, []);
    },

    get(id: string): ChatSession {
      return toChatSession(requireSession(id), messagesOf(id));
    },

    update(id: string, patch: ChatSessionUpdate): ChatSession {
      requireSession(id);
      deps.sessions.updateSession(
        id,
        {
          title: patch.title,
          providerId: patch.providerId,
          model: patch.model,
          thinkingLevel: patch.thinkingLevel,
          systemPrompt: patch.systemPrompt,
        },
        now().toISOString(),
      );
      return toChatSession(requireSession(id), messagesOf(id));
    },

    remove(id: string): void {
      requireSession(id);
      deps.sessions.deleteSession(id);
    },

    transcript(id: string): readonly ChatMessage[] {
      requireSession(id);
      return messagesOf(id);
    },

    append(id: string, input: ChatMessageInput, meta: ChatMessageMeta | null = null): ChatMessage {
      requireSession(id);
      const at = now().toISOString();
      const row = deps.sessions.appendMessage({
        id: newId(),
        sessionId: id,
        role: input.role,
        content: [...input.content],
        attachments: [...input.attachments],
        meta,
        parentMessageId: input.parentMessageId,
        createdAt: at,
      });
      // The session moves to the top of the sidebar as the turn lands, without
      // rewriting the rest of the row — a whole-row update here would let a
      // rename that started before this turn be lost to it.
      deps.sessions.touchSession(id, at);
      return toChatMessage(id, row);
    },

    exportMarkdown(id: string): { readonly filename: string; readonly body: string } {
      const session = this.get(id);
      return {
        filename: `${slug(session.title)}.md`,
        body: markdownOf(session),
      };
    },
  };
}

/**
 * One stored turn as the contract reads it.
 *
 * `meta` is nullable in the row and null for a turn that has not finished, which
 * is the ordinary state of a user message. An unparsable `meta` is treated as
 * absent rather than fatal: it is the reply's statistics, and a transcript that
 * can still be read without them is worth more than a refusal over a number.
 */
function toChatMessage(sessionId: string, row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role === 'assistant' ? 'assistant' : row.role === 'system' ? 'system' : 'user',
    content: parseContent(sessionId, row),
    attachments: parseAttachments(row),
    meta: parseMeta(row),
    parentMessageId: row.parentMessageId,
    createdAt: row.createdAt,
  };
}

function parseContent(sessionId: string, row: ChatMessageRow): ChatMessage['content'] {
  const parsed = contentBlockSchema.array().safeParse(row.content);
  if (!parsed.success) {
    // Named by id, because the operator's next step is to find this row. The
    // column's type is an assertion the driver cannot check, so this is where a
    // shape the contract no longer accepts is actually caught — and a transcript
    // that cannot be read is not something to paper over: the same content is
    // what the next turn sends to a provider.
    throw AppError.internal(
      new Error(`chat message ${row.id} in session ${sessionId} holds content rutekit cannot read`),
    );
  }
  return parsed.data;
}

function parseAttachments(row: ChatMessageRow): ChatMessage['attachments'] {
  const parsed = chatAttachmentSchema.array().safeParse(row.attachments);
  // An attachment list that cannot be read costs the turn its images, and nothing
  // else: the text is still there, and the console renders the message without
  // chips rather than not at all.
  return parsed.success ? parsed.data : [];
}

function parseMeta(row: ChatMessageRow): ChatMessageMeta | null {
  if (row.meta === null) return null;
  const parsed = chatMessageMetaSchema.safeParse(row.meta);
  return parsed.success ? parsed.data : null;
}

/**
 * A sidebar row.
 *
 * The count and the preview are read per session rather than joined in, which is
 * a query per row — and deliberately so. An instance holds tens of conversations
 * on a local SQLite file, where that is microseconds, and the alternative is a
 * correlated subquery in Drizzle for two facts that read plainly this way.
 *
 * **The preview is read defensively**, because this is the one place a bad row
 * must not be fatal: the sidebar is how an operator finds the conversation that
 * has the problem. A turn whose content will not parse simply has no preview
 * line, and the session still lists.
 */
function summarize(row: ChatSessionRow, deps: ChatServiceDeps): ChatSessionSummary {
  const last = deps.sessions.lastMessage(row.id);
  return {
    id: row.id,
    title: row.title,
    providerId: row.providerId,
    model: row.model,
    messageCount: deps.sessions.countMessages(row.id),
    preview: previewOf(last),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The first text block of the newest turn, as far as it fits on one line. */
function previewOf(row: ChatMessageRow | null): string {
  if (row === null) return '';
  const blocks = contentBlockSchema.array().safeParse(row.content);
  if (!blocks.success) return '';
  const text = blocks.data.find((block) => block.type === 'text');
  return text === undefined ? '' : text.text.slice(0, PREVIEW_CHARS);
}

/** A session row with its transcript, as the contract reads it. */
function toChatSession(row: ChatSessionRow, messages: readonly ChatMessage[]): ChatSession {
  return {
    id: row.id,
    title: row.title,
    providerId: row.providerId,
    model: row.model,
    // The column is written only from the contract's enum, so an unreadable one
    // means the row was edited outside rutekit. `auto` is the safe reading: it is
    // the level that asks the model for nothing.
    thinkingLevel: thinkingLevelSchema.safeParse(row.thinkingLevel).data ?? 'auto',
    systemPrompt: row.systemPrompt,
    messages: [...messages],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The conversation as Markdown.
 *
 * Thinking blocks are folded into a `<details>` rather than written inline: they
 * are the model's deliberation, which the console itself collapses once the
 * answer is finished, and a transcript whose prose is interrupted by a page of
 * reasoning is harder to read than the same file with them one click away.
 */
function markdownOf(session: ChatSession): string {
  const lines: string[] = [`# ${session.title}`, ''];

  const routing = [session.providerId, session.model].filter((value) => value !== null);
  if (routing.length > 0) lines.push(`_${routing.join(' · ')}_`, '');
  if (session.systemPrompt !== null && session.systemPrompt !== '') {
    lines.push('## System', '', session.systemPrompt, '');
  }

  for (const message of session.messages) {
    lines.push(`## ${message.role === 'assistant' ? 'Assistant' : message.role === 'system' ? 'System' : 'User'}`, '');
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          lines.push(block.text, '');
          break;
        case 'thinking':
          lines.push('<details><summary>Thinking</summary>', '', block.text, '', '</details>', '');
          break;
        case 'image':
          lines.push(`_[image: ${block.mediaType}]_`, '');
          break;
        case 'tool_use':
          lines.push(`**Tool call: ${block.name}**`, '', '```json', JSON.stringify(block.input, null, 2), '```', '');
          break;
        case 'tool_result':
          lines.push('**Tool result**', '');
          for (const inner of block.content) {
            lines.push(inner.type === 'text' ? inner.text : '_[image]_', '');
          }
          break;
      }
    }
    for (const attachment of message.attachments) {
      lines.push(`_[attachment: ${attachment.name}]_`, '');
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** A title as a filename: recognisable, and incapable of naming a path. */
function slug(title: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, FILENAME_CHARS)
    .replace(/-+$/g, '');
  return cleaned === '' ? 'chat' : cleaned;
}

/** Cursors are plain offsets, matching what the console's pager already sends. */
function offsetOf(cursor: string | null): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * The sidebar's own sort.
 *
 * An absent or unrecognised `sort` leaves the repository's order — newest
 * activity first — alone, for the reason the Routing lists give: that order is
 * what a sidebar is read for, and replacing it with an arbitrary default column
 * would make the first render disagree with the ordering that matters.
 */
function sortRows(rows: readonly ChatSessionSummary[], query: ChatSessionsQuery): ChatSessionSummary[] {
  const sorters: Readonly<Record<string, (row: ChatSessionSummary) => string | number>> = {
    title: (row) => row.title,
    updatedAt: (row) => row.updatedAt,
    createdAt: (row) => row.createdAt,
    messageCount: (row) => row.messageCount,
  };
  const sorter = sorters[query.sort ?? ''];
  if (sorter === undefined) return [...rows];

  const direction = query.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sorter(a);
    const right = sorter(b);
    if (left === right) return a.id.localeCompare(b.id);
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right));
    return order * direction;
  });
}
