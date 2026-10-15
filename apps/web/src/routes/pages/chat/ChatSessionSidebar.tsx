import { MessageSquarePlus, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type { ChatSessionSummary } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import { ConfirmDialog } from '@web/components/ui/Dialog.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useChatSessions, useDeleteChatSession } from '@web/hooks/use-tools.ts';
import { useUrlText } from '@web/hooks/use-url-state.ts';
import { cn } from '@web/lib/cn.ts';
import { formatRelative } from '@web/lib/format.ts';

import { useNewChat } from './use-new-chat.ts';

/**
 * The conversations, and the way into a new one.
 *
 * A session is created the moment the operator asks for one rather than on the
 * first message. That is a deliberate cost: an empty session is a row that
 * exists before it has anything in it. The alternative — hold the draft in the
 * page until it has content — makes the URL lie about what is open, and the URL
 * is how a conversation is shared and returned to.
 */

const SEARCH_PARAM = 'chat_q';

function SessionRow({
  session,
  selected,
  onSelect,
  onDelete,
}: {
  session: ChatSessionSummary;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group/row relative">
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex w-full flex-col gap-0.5 rounded-control border px-2.5 py-2 pr-8 text-left transition duration-(--dur-micro)',
          selected
            ? 'border-border bg-surface-3'
            : 'border-transparent hover:border-border hover:bg-surface-2',
        )}
      >
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{session.title}</span>
          <span className="shrink-0 text-[0.6875rem] text-text-subtle tabular-nums">
            {formatRelative(session.updatedAt)}
          </span>
        </span>
        <span className="line-clamp-1 text-xs text-text-muted">
          {session.preview === '' ? `${String(session.messageCount)} messages` : session.preview}
        </span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete ${session.title}`}
        className={cn(
          'absolute top-2 right-1.5 flex size-6 items-center justify-center rounded-control text-text-subtle',
          'opacity-0 transition duration-(--dur-micro) hover:bg-surface-3 hover:text-danger-text',
          'group-hover/row:opacity-100 focus-visible:opacity-100',
        )}
      >
        <Trash2 aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}

export interface ChatSessionSidebarProps {
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
  /**
   * `card` is the column beside the transcript; `plain` is the same list inside
   * the drawer that replaces it below the breakpoint, where the drawer's own
   * frame and heading already do the work the card would be repeating.
   */
  readonly chrome?: 'card' | 'plain';
}

export function ChatSessionSidebar({
  selectedId,
  onSelect,
  chrome = 'card',
}: ChatSessionSidebarProps) {
  const [search, setSearch] = useUrlText(SEARCH_PARAM);
  const [pendingDelete, setPendingDelete] = useState<ChatSessionSummary | null>(null);

  const sessions = useChatSessions({ q: search, sort: 'updatedAt', direction: 'desc', limit: 50 });
  const remove = useDeleteChatSession();
  const newChat = useNewChat(onSelect);

  const rows = (sessions.data?.pages ?? []).flatMap((page) => page.items);

  return (
    <div
      className={cn(
        'flex h-full min-h-0 flex-col gap-2.5',
        chrome === 'card' && 'rounded-card border border-border bg-surface-1 p-2.5',
      )}
    >
      {chrome === 'plain' ? (
        <Button
          variant="secondary"
          size="sm"
          loading={newChat.pending}
          onClick={newChat.start}
          className="w-full"
        >
          <MessageSquarePlus aria-hidden="true" className="size-3.5" />
          New chat
        </Button>
      ) : (
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-sm font-semibold text-text">Chats</h2>
          <Button variant="secondary" size="sm" loading={newChat.pending} onClick={newChat.start}>
            <MessageSquarePlus aria-hidden="true" className="size-3.5" />
            New
          </Button>
        </div>
      )}

      <Input
        inputSize="sm"
        value={search}
        placeholder="Search chats"
        aria-label="Search chats"
        leading={<Search aria-hidden="true" />}
        onChange={(event) => {
          setSearch(event.target.value);
        }}
      />

      <div className="scrollbar-none -mx-0.5 min-h-0 flex-1 overflow-y-auto px-0.5">
        {sessions.isPending ? (
          <ul role="status" aria-live="polite" aria-label="Loading chats" className="flex flex-col gap-1.5">
            {[0, 1, 2, 3].map((index) => (
              <li key={index} className="rounded-control border border-transparent px-2.5 py-2">
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="mt-2 h-3 w-full" />
              </li>
            ))}
          </ul>
        ) : sessions.isError ? (
          <StateView
            kind="error"
            title="Chats could not be loaded"
            description="The session list did not come back. Retrying usually works."
            action={
              <Button
                variant="secondary"
                size="sm"
                loading={sessions.isFetching}
                onClick={() => {
                  void sessions.refetch();
                }}
              >
                Retry
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <StateView
            kind="empty"
            title={search === '' ? 'No chats yet' : 'Nothing matched'}
            description={
              search === ''
                ? 'Start one and it will appear here.'
                : 'Try a different search, or start a new chat.'
            }
          />
        ) : (
          <div className="flex flex-col gap-1">
            {rows.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                selected={session.id === selectedId}
                onSelect={() => {
                  onSelect(session.id);
                }}
                onDelete={() => {
                  setPendingDelete(session);
                }}
              />
            ))}
            {sessions.hasNextPage && (
              <Button
                variant="ghost"
                size="sm"
                loading={sessions.isFetchingNextPage}
                onClick={() => {
                  void sessions.fetchNextPage();
                }}
              >
                Load more
              </Button>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete this chat?"
        description={
          pendingDelete === null
            ? undefined
            : `"${pendingDelete.title}" and its ${String(pendingDelete.messageCount)} messages will be removed.`
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          const target = pendingDelete;
          if (target === null) return;
          remove.mutate(target.id, {
            onSuccess: () => {
              if (target.id === selectedId) onSelect('');
            },
          });
          setPendingDelete(null);
        }}
      />
    </div>
  );
}
