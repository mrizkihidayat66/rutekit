import { DefaultChatTransport } from 'ai';

import type { ChatAttachment, ChatTurnRequest, ThinkingLevel } from '@contracts';
import { consolePath, consolePaths } from '@contracts';

import { messageText, type ChatUIMessage } from './chat.ts';

/**
 * The chat turn's transport.
 *
 * A turn is the one request in the console that does not answer with a document.
 * The reply is written onto the response as it is generated, so the client has
 * to read frames rather than parse a body — and the AI SDK already has that
 * reader, along with the chunk schema that says what a valid frame is. Writing
 * another one here would be a second implementation of a protocol that only
 * needs one, and the two would disagree the first time the protocol moved.
 *
 * So the transport supplies what the SDK cannot know — which URL, and what body
 * this product sends — and the SDK supplies the rest.
 */

export interface TurnConfig {
  readonly providerId: string | null;
  readonly model: string | null;
  readonly thinkingLevel: ThinkingLevel;
}

export interface ChatTransportOptions {
  readonly sessionId: string;
  /**
   * Read at send time, not at construction. A turn's routing and its attachments
   * are whatever the header and the composer hold *when the operator presses
   * send*, and the transport is built once per session rather than once per
   * keystroke.
   */
  readonly readConfig: () => TurnConfig;
  readonly takeAttachments: () => readonly ChatAttachment[];
  /**
   * The turn this one was branched from, when the operator opened this chat from
   * a message in another one. Read per turn rather than captured, because the
   * branch outlives the first message sent on it.
   */
  readonly readParentId?: (() => string | null) | undefined;
}

/**
 * The request body, which is the contract's own turn shape.
 *
 * The transcript is read back out of the SDK's messages rather than kept
 * alongside them: the SDK is what knows what the operator actually said,
 * including anything a previous turn left in place, and a second copy would be
 * one more thing to keep in step.
 */
function turnBody(messages: readonly ChatUIMessage[], options: ChatTransportOptions): ChatTurnRequest {
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const text = lastUser === undefined ? '' : messageText(lastUser);
  const config = options.readConfig();

  return {
    role: 'user',
    content: text === '' ? [{ type: 'text', text: '' }] : [{ type: 'text', text }],
    attachments: [...options.takeAttachments()],
    parentMessageId: options.readParentId?.() ?? null,
    providerId: config.providerId,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
  };
}

export function createChatTransport(options: ChatTransportOptions): DefaultChatTransport<ChatUIMessage> {
  return new DefaultChatTransport<ChatUIMessage>({
    api: consolePath(consolePaths.chatMessages, { id: options.sessionId }),
    prepareSendMessagesRequest: ({ messages }) => ({
      body: turnBody(messages, options),
    }),
  });
}
