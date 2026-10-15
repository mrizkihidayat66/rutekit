import { useCallback } from 'react';

import { useCreateChatSession } from '@web/hooks/use-tools.ts';

/**
 * Opening a new conversation.
 *
 * Two places offer it — the list's own button and the panel shown when nothing
 * is open — and they have to behave identically, including selecting the session
 * they just made. Sharing the hook is what keeps them from drifting into two
 * slightly different ideas of what "new chat" does.
 */
export function useNewChat(onSelect: (id: string) => void): {
  readonly start: () => void;
  readonly pending: boolean;
} {
  const create = useCreateChatSession();

  const start = useCallback(() => {
    create.mutate(
      { title: 'New chat', providerId: null, model: null, thinkingLevel: 'auto', systemPrompt: null },
      {
        onSuccess: (session) => {
          onSelect(session.id);
        },
      },
    );
  }, [create, onSelect]);

  return { start, pending: create.isPending };
}
