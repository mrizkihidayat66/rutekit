import type { Migration } from './types.ts';

/**
 * Chat sessions and their transcript (C9, FR-7.7).
 *
 * Two tables rather than one row holding a JSON message array. A transcript is
 * append-only and read one page at a time; a session is renamed, re-pointed at a
 * different model, and listed in a sidebar. Those are different lifetimes, and
 * keeping the messages in a column would mean rewriting the whole conversation
 * every time a turn lands — which, for a long chat, is the entire history written
 * again per message.
 *
 * **`content` and `attachments` are JSON columns.** They hold the canonical
 * content blocks and the attachment blobs the contract already defines, and
 * nothing queries inside them: a message is read whole or not at all. A table per
 * block would be a join for every turn, for a shape the pivot already settled.
 *
 * **Attachments are inline, which is a size decision worth naming.** The contract
 * carries an image as base64 in `data`, and the read model returns the same
 * shape, so the transcript can re-render without a second request. The client
 * scales images to 1568px and refuses anything over 4 MB, and the server enforces
 * its own ceiling on the way in — but a chat with many images is a large row, and
 * that is the cost of a self-contained transcript.
 *
 * `parent_message_id` is what makes a branch a branch (FR-7.8): a message
 * created from another one points at it, and the transcript is a tree that the
 * console renders as a line. It is a plain column rather than a foreign key, for
 * the reason `0005` gives — SQLite only enforces those with a pragma the
 * connection does not set.
 *
 * `position` orders a session's messages. It is stored rather than derived from
 * `created_at`, because two messages in the same millisecond are ordinary here —
 * the user's turn and the assistant's reply are written moments apart — and an
 * order that depends on a tie-break is an order that can flip.
 */
export const migration0011: Migration = {
  id: 11,
  name: 'chat',
  statements: [
    `create table chat_sessions (
       id text primary key,
       title text not null,
       provider_id text,
       model text,
       thinking_level text not null default 'auto',
       system_prompt text,
       created_at text not null,
       updated_at text not null
     );`,

    `create table chat_messages (
       id text primary key,
       session_id text not null,
       position integer not null,
       role text not null,
       content text not null,
       attachments text not null default '[]',
       meta text,
       parent_message_id text,
       created_at text not null
     );`,

    // The sidebar lists sessions newest-first, and the transcript reads one
    // session's messages in order — the two reads this feature has.
    `create index chat_sessions_updated_idx on chat_sessions (updated_at);`,
    `create index chat_messages_session_idx on chat_messages (session_id, position);`,
  ],
};
