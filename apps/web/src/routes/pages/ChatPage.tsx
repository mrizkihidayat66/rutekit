import { MessageSquarePlus, PanelLeft } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@web/components/ui/Button.tsx';
import { Drawer } from '@web/components/ui/Drawer.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useImmersiveRoute } from '@web/hooks/use-immersive-route.ts';
import { useChatSession } from '@web/hooks/use-tools.ts';
import { useUrlParam } from '@web/hooks/use-url-state.ts';

import { ChatPane } from './chat/ChatPane.tsx';
import { ChatSessionSidebar } from './chat/ChatSessionSidebar.tsx';
import { CHAT_PARAM } from './chat/chat.ts';
import { useNewChat } from './chat/use-new-chat.ts';

/**
 * Chat.
 *
 * The one page in the console that takes the whole window. Everything else is a
 * document to be read and scrolled; a conversation is a workspace, so the page
 * claims the full height, drops the shell's footer, and puts its own scroll on
 * the transcript instead of the page — a composer that scrolls away is a
 * composer the operator has to go looking for.
 *
 * That is also why the page is `h-full` at every width rather than only on the
 * wide ones. The list of chats is a column beside the transcript when there is
 * room for one and a drawer over it when there is not; either way it never
 * becomes a band stacked above the conversation, which used to push the page
 * past the viewport and take the composer off the bottom of the screen with it.
 *
 * The outer element is only a query container. A container query is measured
 * against an ancestor box, never the element's own, so the row below cannot ask
 * how wide the page is while it is the thing being measured.
 *
 * Which conversation is open lives in the URL, so a chat is a link.
 */
export function ChatPage() {
  useImmersiveRoute();
  const [selectedId, setSelectedId] = useUrlParam<string>(CHAT_PARAM, '');
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const session = useChatSession(selectedId === '' ? null : selectedId);
  const newChat = useNewChat(setSelectedId);

  // Picking a chat is the end of the visit to the list, so the drawer goes away
  // with it — otherwise the conversation opens behind the thing covering it.
  const selectSession = (id: string): void => {
    setSelectedId(id);
    setSessionsOpen(false);
  };

  return (
    <div className="@container h-full">
      <div className="flex h-full min-h-0 flex-col gap-3 p-5 @[1000px]:flex-row">
        <div className="hidden min-h-0 shrink-0 @[1000px]:block @[1000px]:w-[19rem]">
          <ChatSessionSidebar selectedId={selectedId} onSelect={setSelectedId} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {selectedId === '' ? (
            <div className="flex flex-1 items-center justify-center rounded-card border border-dashed border-border">
              <StateView
                kind="empty"
                icon={MessageSquarePlus}
                title="No chat open"
                description="Open one from the list, or start a new conversation."
                action={
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setSessionsOpen(true);
                      }}
                      className="@[1000px]:hidden"
                    >
                      <PanelLeft aria-hidden="true" className="size-3.5" />
                      Chats
                    </Button>
                    <Button loading={newChat.pending} onClick={newChat.start}>
                      <MessageSquarePlus aria-hidden="true" className="size-3.5" />
                      New chat
                    </Button>
                  </div>
                }
              />
            </div>
          ) : session.isPending ? (
            <div
              role="status"
              aria-live="polite"
              aria-label="Loading conversation"
              className="flex flex-1 flex-col gap-3"
            >
              <Skeleton className="h-16 w-full rounded-card" />
              <Skeleton className="h-10 w-2/3 rounded-card" />
              <Skeleton className="h-24 w-full rounded-card" />
              <Skeleton className="h-20 w-1/2 rounded-card" />
            </div>
          ) : session.isError ? (
            <div className="flex flex-1 items-center justify-center rounded-card border border-border">
              <StateView
                kind="error"
                title="That conversation could not be opened"
                description="It may have been deleted, or the request failed. Retrying usually works."
                action={
                  <Button
                    variant="secondary"
                    loading={session.isFetching}
                    onClick={() => {
                      void session.refetch();
                    }}
                  >
                    Retry
                  </Button>
                }
              />
            </div>
          ) : (
            <ChatPane
              key={session.data.id}
              session={session.data}
              onOpenSessions={() => {
                setSessionsOpen(true);
              }}
            />
          )}
        </div>

        <Drawer
          open={sessionsOpen}
          onOpenChange={setSessionsOpen}
          side="left"
          width="sm"
          title="Chats"
          description="Pick a conversation, or start a new one."
        >
          <ChatSessionSidebar selectedId={selectedId} onSelect={selectSession} chrome="plain" />
        </Drawer>
      </div>
    </div>
  );
}
