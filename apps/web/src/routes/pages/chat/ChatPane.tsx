import { AlertTriangle, RotateCcw, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { useQueryClient } from '@tanstack/react-query';

import type { ChatAttachment, ChatSession } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import { queryKeys } from '@web/data/query-keys.ts';
import { useUpdateChatSession } from '@web/hooks/use-tools.ts';
import { cn } from '@web/lib/cn.ts';

import { ChatComposer, type ComposerSeed } from './ChatComposer.tsx';
import { ChatHeader } from './ChatHeader.tsx';
import { ChatMessageItem } from './ChatMessageItem.tsx';
import { createChatTransport } from './chat-transport.ts';
import { configFromSession, messageText, toUIMessages, type ChatConfig, type ChatUIMessage } from './chat.ts';

/**
 * One conversation, live.
 *
 * The whole reason this is a separate component from the page is the key on it:
 * a session is a different conversation, so it gets a different chat instance,
 * and remounting is how that happens without a reset effect that has to remember
 * every piece of state the SDK holds. The page picks the session; this renders
 * exactly one.
 *
 * The SDK owns the transcript while a turn is in flight and the console owns it
 * once the turn is stored, so the stored messages are only ever the *starting*
 * point — passing them in on every render would fight the stream. When a turn
 * finishes, the session is re-read instead, which is what makes the sidebar's
 * preview and message count catch up.
 */

/** How close to the bottom still counts as "following along". */
const STICK_THRESHOLD_PX = 64;

export interface ChatPaneProps {
  readonly session: ChatSession;
  /** Handed to the header, which offers the chat list when it is not on screen. */
  readonly onOpenSessions: () => void;
}

export function ChatPane({ session, onOpenSessions }: ChatPaneProps) {
  const client = useQueryClient();
  const update = useUpdateChatSession(session.id);

  const [config, setConfig] = useState<ChatConfig>(() => configFromSession(session));
  const [pending, setPending] = useState<readonly ChatAttachment[]>([]);
  const [seed, setSeed] = useState<ComposerSeed | undefined>(undefined);
  const [branchOf, setBranchOf] = useState<string | null>(null);

  // The transport reads these at send time, so they are refs: it is built once
  // per session and must see the values the operator has right now, not the ones
  // from the render it was created in.
  const configRef = useRef(config);
  const pendingRef = useRef<readonly ChatAttachment[]>([]);
  const branchRef = useRef<string | null>(null);

  useEffect(() => {
    configRef.current = config;
  }, [config]);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  useEffect(() => {
    branchRef.current = branchOf;
  }, [branchOf]);

  const transport = useMemo(
    () =>
      createChatTransport({
        sessionId: session.id,
        readConfig: () => configRef.current,
        takeAttachments: () => {
          const taken = pendingRef.current;
          pendingRef.current = [];
          setPending([]);
          return taken;
        },
        readParentId: () => branchRef.current,
      }),
    [session.id],
  );

  const [initialMessages] = useState<ChatUIMessage[]>(() => toUIMessages(session.messages));

  const onFinish = useCallback(() => {
    void client.invalidateQueries({ queryKey: queryKeys.chatSession(session.id) });
    void client.invalidateQueries({ queryKey: ['chat', 'sessions'] });
  }, [client, session.id]);

  const { messages, sendMessage, regenerate, stop, setMessages, status, error, clearError } =
    useChat<ChatUIMessage>({
      id: session.id,
      messages: initialMessages,
      transport,
      onFinish,
    });

  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const element = scrollerRef.current;
    if (element === null || !stickRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messages]);

  const busy = status === 'submitted' || status === 'streaming';

  const changeConfig = useCallback(
    (next: ChatConfig) => {
      setConfig(next);
      update.mutate({
        providerId: next.providerId,
        model: next.model,
        thinkingLevel: next.thinkingLevel,
      });
    },
    [update],
  );

  const editMessage = useCallback(
    (id: string, text: string) => {
      setMessages((current) => current.slice(0, current.findIndex((message) => message.id === id)));
      setSeed({ text, nonce: Date.now() });
    },
    [setMessages],
  );

  const branchMessage = useCallback((id: string) => {
    setBranchOf(id);
  }, []);

  const lastAssistantId = [...messages].reverse().find((message) => message.role === 'assistant')?.id ?? '';

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <ChatHeader
        title={session.title}
        config={config}
        onConfigChange={changeConfig}
        onOpenSessions={onOpenSessions}
      />

      <div
        ref={scrollerRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickRef.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD_PX;
        }}
        className="scrollbar-none min-h-0 flex-1 overflow-y-auto"
      >
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex max-w-md flex-col items-center gap-2 px-6 text-center animate-rise">
              <span className="mb-1 flex size-11 items-center justify-center rounded-pill border border-border bg-surface-2 text-text-muted">
                <Sparkles aria-hidden="true" className="size-5" />
              </span>
              <p className="text-sm font-medium text-text">{session.title}</p>
              <p className="text-xs text-text-muted">
                Pick a provider, a model and how hard it should think above, then ask. Drop or paste an
                image and it goes with the prompt.
              </p>
              {branchOf !== null && (
                <p className="text-xs text-text-subtle">This chat was branched from an earlier message.</p>
              )}
            </div>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-5">
            {messages.map((message) => (
              <ChatMessageItem
                key={message.id}
                message={message}
                streaming={busy && message.id === messages[messages.length - 1]?.id}
                onEdit={
                  message.role === 'user'
                    ? () => {
                        editMessage(message.id, messageText(message));
                      }
                    : undefined
                }
                onRegenerate={
                  message.role === 'assistant' && message.id === lastAssistantId && !busy
                    ? () => {
                        void regenerate();
                      }
                    : undefined
                }
                onBranch={
                  message.role === 'assistant'
                    ? () => {
                        branchMessage(message.id);
                      }
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </div>

      {status === 'error' && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-card border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger-text"
        >
          <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {error?.message ?? 'The reply could not be generated.'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              clearError();
              void regenerate();
            }}
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
            Retry
          </Button>
        </div>
      )}

      <div className={cn('mx-auto w-full max-w-3xl pb-1', messages.length === 0 && 'pb-4')}>
        <ChatComposer
          status={status}
          attachments={pending}
          onAttachmentsChange={setPending}
          onSend={(text) => {
            void sendMessage({ text });
          }}
          onStop={() => {
            void stop();
          }}
          seed={seed}
        />
      </div>
    </div>
  );
}
