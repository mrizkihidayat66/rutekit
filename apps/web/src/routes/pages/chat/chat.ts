import type {
  ChatAttachment,
  ChatMessage,
  ChatMessageMeta,
  ChatSession,
  ContentBlock,
  FinishReason,
  ImageBlock,
  ThinkingLevel,
} from '@contracts';
import type { UIMessage } from 'ai';

/** Chat vocabulary and the bridge between a stored turn and a rendered one. */

/**
 * A chat message as the streaming layer sees it.
 *
 * The AI SDK owns the transcript while a turn is in flight — it is the thing
 * accumulating deltas — and the console owns it once the turn is stored. Both
 * sides have to agree on one shape, so the page renders `UIMessage` and converts
 * stored turns into it, rather than keeping two renderers that drift.
 */
export type ChatUIMessage = UIMessage<ChatMessageMeta>;

/** The session in the URL, so a conversation is a link. */
export const CHAT_PARAM = 'chat';

export const THINKING_LEVELS: readonly ThinkingLevel[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];

const THINKING_LABELS: Readonly<Record<ThinkingLevel, string>> = {
  auto: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export function thinkingLabel(level: ThinkingLevel): string {
  return THINKING_LABELS[level];
}

export const THINKING_OPTIONS = THINKING_LEVELS.map((level) => ({
  value: level,
  label: THINKING_LABELS[level],
}));

/**
 * How a turn ended, in words.
 *
 * `finishReason` is the one field that appears in both vocabularies — the
 * contract spells it with underscores and the wire with hyphens — so the label
 * lookup normalises first and the page never sees the difference.
 */
const FINISH_LABELS: Readonly<Record<FinishReason, string>> = {
  stop: 'Finished',
  length: 'Hit the length limit',
  tool_calls: 'Called a tool',
  content_filter: 'Filtered',
  error: 'Errored',
  aborted: 'Stopped',
};

export function finishLabel(reason: string): string {
  const normalised = reason.replace(/-/g, '_') as FinishReason;
  return FINISH_LABELS[normalised] ?? 'Finished';
}

export function isFinishTone(reason: string): 'neutral' | 'warning' | 'danger' {
  const normalised = reason.replace(/-/g, '_');
  if (normalised === 'error') return 'danger';
  if (normalised === 'length' || normalised === 'content_filter') return 'warning';
  return 'neutral';
}

/** Everything the transcript says for a message, for copy and for the preview. */
export function messageText(message: ChatUIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => ('text' in part ? part.text : ''))
    .join('\n\n')
    .trim();
}

/** The first line of a prompt, short enough for a session title. */
export function titleFromPrompt(prompt: string): string {
  const line = prompt.trim().split('\n')[0] ?? '';
  const clipped = line.length > 60 ? `${line.slice(0, 57)}…` : line;
  return clipped === '' ? 'New chat' : clipped;
}

/**
 * An attachment as a URL.
 *
 * An image's `data` is base64 and a pasted file's `data` is its own text, so the
 * two need different encodings to become the same kind of URL. Getting this
 * wrong is invisible until someone clicks the chip, which is exactly the kind of
 * bug that survives a review.
 */
export function attachmentUrl(attachment: ChatAttachment): string {
  if (attachment.kind === 'image') return `data:${attachment.mimeType};base64,${attachment.data}`;
  return `data:${attachment.mimeType};charset=utf-8,${encodeURIComponent(attachment.data)}`;
}

/**
 * An image block as something an `<img>` can load.
 *
 * An inline image is base64 and a block the client sent by reference carries the
 * URL itself; both end up as the same kind of string, which is why this is one
 * function rather than a branch at the call site.
 */
function imageUrl(block: ImageBlock): string {
  if (block.url !== null) return block.url;
  return `data:${block.mediaType};base64,${block.data}`;
}

function toolResultText(block: Extract<ContentBlock, { type: 'tool_result' }>): string {
  return block.content
    .map((part) => (part.type === 'text' ? part.text : `[${part.mediaType}]`))
    .join('\n');
}

/**
 * Rebuild a stored turn as a renderable message.
 *
 * A stored turn is a list of content blocks; a live turn is a list of streamed
 * parts. They are close but not the same, and the differences are handled here
 * rather than in the renderer:
 *
 *   - a `tool_use` and its `tool_result` are one thing on screen, so the result
 *     is folded into the call before either is emitted;
 *   - an image that arrived as an attachment is *also* present as an image block
 *     in the stored content, and rendering both would show it twice — so the
 *     attachment wins and the duplicate block is dropped;
 *   - an attachment with no matching block at all — a pasted file, which has no
 *     reason to be in the content — is emitted on its own, or it would be lost.
 */
export function toUIMessage(message: ChatMessage): ChatUIMessage {
  const results = new Map<string, Extract<ContentBlock, { type: 'tool_result' }>>();
  for (const block of message.content) {
    if (block.type === 'tool_result') results.set(block.toolUseId, block);
  }

  const attachedData = new Set(message.attachments.map((attachment) => attachment.data));
  const blockData = new Set(
    message.content.filter((block) => block.type === 'image').map((block) => block.data),
  );
  const parts: ChatUIMessage['parts'] = [];

  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        if (block.text.trim() !== '') parts.push({ type: 'text', text: block.text });
        break;
      case 'thinking':
        parts.push({ type: 'reasoning', text: block.text });
        break;
      case 'image':
        if (!attachedData.has(block.data)) {
          parts.push({ type: 'file', mediaType: block.mediaType, url: imageUrl(block) });
        }
        break;
      case 'tool_use': {
        const result = results.get(block.id);
        parts.push(
          result === undefined
            ? { type: 'dynamic-tool', toolName: block.name, toolCallId: block.id, state: 'input-available', input: block.input }
            : {
                type: 'dynamic-tool',
                toolName: block.name,
                toolCallId: block.id,
                state: 'output-available',
                input: block.input,
                output: toolResultText(result),
              },
        );
        break;
      }
      case 'tool_result':
        break;
    }
  }

  for (const attachment of message.attachments) {
    if (blockData.has(attachment.data)) continue;
    parts.push({
      type: 'file',
      mediaType: attachment.mimeType,
      filename: attachment.name,
      url: attachmentUrl(attachment),
    });
  }

  return {
    id: message.id,
    role: message.role,
    parts,
    ...(message.meta === null ? {} : { metadata: message.meta }),
  };
}

export function toUIMessages(messages: readonly ChatMessage[]): ChatUIMessage[] {
  return messages.map(toUIMessage);
}

/** The routing trio a turn is sent with, and what the header holds. */
export interface ChatConfig {
  readonly providerId: string | null;
  readonly model: string | null;
  readonly thinkingLevel: ThinkingLevel;
}

/**
 * What a stored session says about its routing.
 *
 * A session saved before a model was chosen can carry an empty string where the
 * rest of the console writes null, and an empty string is not a model name — it
 * is a missing one wearing a string's clothes. Normalising here keeps every
 * downstream comparison honest.
 */
export function configFromSession(session: ChatSession): ChatConfig {
  return {
    providerId: session.providerId,
    model: session.model === '' ? null : session.model,
    thinkingLevel: session.thinkingLevel,
  };
}

/** What a stored turn says, without going through the UI message shape. */
export function storedText(message: ChatMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => ('text' in block ? block.text : ''))
    .join('\n\n')
    .trim();
}

export function attachmentSummary(attachment: ChatAttachment): string {
  const size = attachment.byteSize < 1024 ? `${attachment.byteSize} B` : `${Math.round(attachment.byteSize / 1024)} KB`;
  const dimensions =
    attachment.width === null || attachment.height === null ? '' : ` · ${attachment.width}×${attachment.height}`;
  return `${size}${dimensions}`;
}
