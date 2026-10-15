import { Check, Copy, GitBranch, Pencil, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import type { ChatMessageMeta } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatDurationMs, formatTokens, formatTps } from '@web/lib/format.ts';

import { ChatMarkdown } from './ChatMarkdown.tsx';
import { ThinkingBlock } from './ThinkingBlock.tsx';
import { ToolCallChip, type ToolCallView } from './ToolCallChip.tsx';
import { finishLabel, isFinishTone, type ChatUIMessage } from './chat.ts';

/**
 * One turn in the transcript.
 *
 * The two roles are laid out differently on purpose. A prompt is a small block
 * on the right — it is the operator's own words and they already know what they
 * said. An answer takes the full width and is the thing being read, so it gets
 * the room, the prose styling, and the metadata footer that says what it cost.
 */

function toolCalls(parts: ChatUIMessage['parts']): ToolCallView[] {
  const calls: ToolCallView[] = [];
  for (const part of parts) {
    if (part.type === 'dynamic-tool') {
      calls.push({
        id: part.toolCallId,
        name: part.toolName,
        input: 'input' in part ? part.input : undefined,
        output: 'output' in part ? part.output : undefined,
        state:
          part.state === 'input-streaming'
            ? 'streaming'
            : part.state === 'output-available'
              ? 'done'
              : part.state === 'output-error'
                ? 'error'
                : 'running',
      });
      continue;
    }
    if (part.type.startsWith('tool-')) {
      const tool = part as { toolCallId?: string; state?: string; input?: unknown; output?: unknown };
      calls.push({
        id: tool.toolCallId ?? part.type,
        name: part.type.slice('tool-'.length),
        input: tool.input,
        output: tool.output,
        state:
          tool.state === 'input-streaming'
            ? 'streaming'
            : tool.state === 'output-available'
              ? 'done'
              : tool.state === 'output-error'
                ? 'error'
                : 'running',
      });
    }
  }
  return calls;
}

function MessageMeta({ meta }: { meta: ChatMessageMeta }) {
  const parts: string[] = [];
  if (meta.ttftMs !== null) parts.push(`TTFB ${formatDurationMs(meta.ttftMs)}`);
  if (meta.totalMs !== null) parts.push(`total ${formatDurationMs(meta.totalMs)}`);
  if (meta.tokensPerSecond !== null) parts.push(formatTps(meta.tokensPerSecond));
  if (meta.usage !== null) parts.push(`${formatTokens(meta.usage.totalTokens)} tok`);

  if (parts.length === 0 && meta.finishReason === null) return null;

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-text-subtle tabular-nums">
      {parts.map((entry) => (
        <span key={entry}>{entry}</span>
      ))}
      {meta.finishReason !== null && meta.finishReason !== 'stop' && (
        <Badge tone={isFinishTone(meta.finishReason)} size="sm">
          {finishLabel(meta.finishReason)}
        </Badge>
      )}
    </div>
  );
}

function MessageActions({
  text,
  onEdit,
  onRegenerate,
  onBranch,
}: {
  text: string;
  onEdit?: (() => void) | undefined;
  onRegenerate?: (() => void) | undefined;
  onBranch?: (() => void) | undefined;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-center gap-0.5 opacity-0 transition duration-(--dur-micro) group-hover:opacity-100 focus-within:opacity-100">
      <Button
        variant="ghost"
        size="icon"
        aria-label={copied ? 'Copied' : 'Copy message'}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => {
              setCopied(false);
            }, 1500);
          });
        }}
      >
        {copied ? (
          <Check aria-hidden="true" className="size-3.5 text-success" />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" />
        )}
      </Button>
      {onEdit !== undefined && (
        <Button variant="ghost" size="icon" aria-label="Edit and resend" onClick={onEdit}>
          <Pencil aria-hidden="true" className="size-3.5" />
        </Button>
      )}
      {onRegenerate !== undefined && (
        <Button variant="ghost" size="icon" aria-label="Regenerate" onClick={onRegenerate}>
          <RefreshCw aria-hidden="true" className="size-3.5" />
        </Button>
      )}
      {onBranch !== undefined && (
        <Button variant="ghost" size="icon" aria-label="Branch from here" onClick={onBranch}>
          <GitBranch aria-hidden="true" className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

export interface ChatMessageItemProps {
  readonly message: ChatUIMessage;
  readonly streaming: boolean;
  readonly onEdit?: (() => void) | undefined;
  readonly onRegenerate?: (() => void) | undefined;
  readonly onBranch?: (() => void) | undefined;
}

export function ChatMessageItem({ message, streaming, onEdit, onRegenerate, onBranch }: ChatMessageItemProps) {
  const isUser = message.role === 'user';
  const reasoning = message.parts
    .filter((part) => part.type === 'reasoning')
    .map((part) => ('text' in part ? part.text : ''))
    .join('\n\n');
  const files = message.parts.filter((part) => part.type === 'file' || part.type === 'reasoning-file');
  const calls = toolCalls(message.parts);
  const text = message.parts
    .filter((part) => part.type === 'text')
    .map((part) => ('text' in part ? part.text : ''))
    .join('');
  const meta = message.metadata;

  return (
    <article className={cn('group flex flex-col gap-2', isUser ? 'items-end' : 'items-stretch')}>
      <div className={cn('flex w-full items-center gap-2', isUser && 'justify-end')}>
        <span className="text-[0.6875rem] font-medium tracking-wide text-text-subtle uppercase">
          {isUser ? 'You' : 'Assistant'}
        </span>
        <MessageActions text={text} onEdit={onEdit} onRegenerate={onRegenerate} onBranch={onBranch} />
      </div>

      {reasoning !== '' && <ThinkingBlock text={reasoning} streaming={streaming} />}

      {files.length > 0 && (
        <div className={cn('flex flex-wrap gap-2', isUser && 'justify-end')}>
          {files.map((part, index) => {
            const url = 'url' in part ? part.url : '';
            const mediaType = 'mediaType' in part ? part.mediaType : 'application/octet-stream';
            const filename = 'filename' in part && typeof part.filename === 'string' ? part.filename : null;
            return mediaType.startsWith('image/') ? (
              <img
                key={`${String(index)}-${mediaType}`}
                src={url}
                alt={filename ?? 'Attachment'}
                className="max-h-64 rounded-control border border-border object-contain"
              />
            ) : (
              <span
                key={`${String(index)}-${mediaType}`}
                className="rounded-control border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-xs text-text-muted"
              >
                {filename ?? mediaType}
              </span>
            );
          })}
        </div>
      )}

      <div
        className={cn(
          'min-w-0',
          isUser
            ? 'max-w-[min(42rem,88%)] rounded-card rounded-br-control border border-border bg-surface-2 px-3.5 py-2.5'
            : 'w-full',
        )}
      >
        {text !== '' ? (
          <ChatMarkdown streaming={streaming}>{text}</ChatMarkdown>
        ) : streaming ? (
          <p className="flex items-center gap-1.5 text-sm text-text-muted" role="status" aria-live="polite">
            <span className="size-1.5 rounded-pill bg-accent animate-pulse-soft" aria-hidden="true" />
            Waiting for the first token…
          </p>
        ) : null}
      </div>

      {calls.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {calls.map((call) => (
            <ToolCallChip key={call.id} call={call} />
          ))}
        </div>
      )}

      {meta !== undefined && !isUser && <MessageMeta meta={meta} />}
    </article>
  );
}
