import { PanelLeft } from 'lucide-react';

import { Button } from '@web/components/ui/Button.tsx';

import { ChatModelPicker } from './ChatModelPicker.tsx';
import type { ChatConfig } from './chat.ts';

/**
 * The one line above the transcript: which conversation, and what answers it.
 *
 * It used to be a bordered band holding three labelled selects, which cost a
 * whole strip of the page for something set once and then left alone. The
 * choices now live behind a single button, and the row does the job it should
 * have had: naming the conversation, and offering the chat list at the widths
 * where the list is not a column beside it.
 */

export interface ChatHeaderProps {
  readonly title: string;
  readonly config: ChatConfig;
  readonly onConfigChange: (next: ChatConfig) => void;
  /** Opens the chat list where it is not a column — below the container breakpoint. */
  readonly onOpenSessions: () => void;
}

export function ChatHeader({ title, config, onConfigChange, onOpenSessions }: ChatHeaderProps) {
  return (
    <div className="flex items-center gap-2 rounded-card border border-border bg-surface-1 px-2 py-1.5">
      <Button
        variant="ghost"
        size="icon"
        aria-label="Chats"
        onClick={onOpenSessions}
        className="@[1000px]:hidden"
      >
        <PanelLeft aria-hidden="true" className="size-4" />
      </Button>

      <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-text">{title}</h2>

      <ChatModelPicker config={config} onConfigChange={onConfigChange} />
    </div>
  );
}
