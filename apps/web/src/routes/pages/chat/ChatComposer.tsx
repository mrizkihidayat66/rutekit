import { ArrowUp, Loader2, Paperclip, Square, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { ChatStatus } from 'ai';

import type { ChatAttachment } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import { Textarea } from '@web/components/ui/Textarea.tsx';
import { cn } from '@web/lib/cn.ts';

import { filesFromClipboard, readAttachments, type AttachmentRejection } from './attachment.ts';
import { attachmentSummary } from './chat.ts';

/**
 * Where a turn is written.
 *
 * Two things here are less obvious than they look. The first is that a file can
 * arrive three ways — dropped, pasted, or picked — and all three have to land in
 * the same place, because an operator who pastes a screenshot expects the same
 * result as one who drops it. The second is that the textarea grows with the
 * content instead of scrolling: a prompt being composed is being *read*, and a
 * three-line box that scrolls a five-line prompt is a box that hides the thing
 * the operator is checking before they send it.
 */

/** Preview strip for what is about to be sent, before it is sent. */
function PendingAttachment({ attachment, onRemove }: { attachment: ChatAttachment; onRemove: () => void }) {
  const image = attachment.kind === 'image';
  return (
    <div className="group/att relative overflow-hidden rounded-control border border-border bg-surface-3">
      {image ? (
        <img
          src={`data:${attachment.mimeType};base64,${attachment.data}`}
          alt={attachment.name}
          className="h-16 w-16 object-cover"
        />
      ) : (
        <div className="flex h-16 w-16 flex-col items-center justify-center gap-1 px-1.5 text-center">
          <Paperclip aria-hidden="true" className="size-3.5 text-text-muted" />
          <span className="line-clamp-2 text-[0.625rem] leading-tight text-text-muted">{attachment.name}</span>
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${attachment.name}`}
        className="absolute top-0.5 right-0.5 flex size-5 items-center justify-center rounded-pill bg-surface-1/85 text-text-muted transition duration-(--dur-micro) hover:text-danger-text"
      >
        <X aria-hidden="true" className="size-3" />
      </button>
      <span className="sr-only">{attachmentSummary(attachment)}</span>
    </div>
  );
}

/**
 * Text to put in the box, and a token that says when to put it there.
 *
 * Editing a sent message means the prompt goes back into the composer to be
 * changed and sent again. That is a one-shot event rather than a controlled
 * value — the operator must be able to keep typing after it lands — so it
 * arrives with a counter instead of as a value that keeps winning.
 */
export interface ComposerSeed {
  readonly text: string;
  readonly nonce: number;
}

export interface ChatComposerProps {
  readonly status: ChatStatus;
  readonly attachments: readonly ChatAttachment[];
  readonly onAttachmentsChange: (next: readonly ChatAttachment[]) => void;
  readonly onSend: (text: string) => void;
  readonly onStop: () => void;
  readonly disabled?: boolean;
  readonly seed?: ComposerSeed | undefined;
}

export function ChatComposer({
  status,
  attachments,
  onAttachmentsChange,
  onSend,
  onStop,
  disabled = false,
  seed,
}: ChatComposerProps) {
  const [draft, setDraft] = useState('');
  const [rejections, setRejections] = useState<readonly AttachmentRejection[]>([]);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const seedNonce = seed?.nonce ?? 0;
  const seedText = seed?.text ?? '';
  useEffect(() => {
    if (seedNonce === 0) return;
    setDraft(seedText);
  }, [seedNonce, seedText]);

  const busy = status === 'submitted' || status === 'streaming';
  const canSend = !disabled && !busy && (draft.trim() !== '' || attachments.length > 0);

  const intake = useCallback(
    (files: readonly File[]) => {
      if (files.length === 0) return;
      setReading(true);
      void readAttachments(files)
        .then((batch) => {
          if (batch.attachments.length > 0) onAttachmentsChange([...attachments, ...batch.attachments]);
          setRejections(batch.rejections);
        })
        .finally(() => {
          setReading(false);
        });
    },
    [attachments, onAttachmentsChange],
  );

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!canSend) return;
    setDraft('');
    setRejections([]);
    onSend(text);
  }, [canSend, draft, onSend]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFromClipboard(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    intake(files);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    intake(Array.from(event.dataTransfer.files));
  };

  return (
    <div
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={onDrop}
      className="relative"
    >
      <div
        className={cn(
          'flex flex-col gap-2 rounded-card border bg-surface-2 p-2.5 transition duration-(--dur-micro)',
          dragging ? 'border-accent bg-accent/5' : 'border-border focus-within:border-border-strong',
        )}
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <PendingAttachment
                key={attachment.id}
                attachment={attachment}
                onRemove={() => {
                  onAttachmentsChange(attachments.filter((entry) => entry.id !== attachment.id));
                }}
              />
            ))}
          </div>
        )}

        <Textarea
          autoGrow
          rows={1}
          value={draft}
          disabled={disabled}
          aria-label="Message"
          placeholder={busy ? 'Waiting for the reply…' : 'Ask anything, or drop a file'}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            setDraft(event.target.value);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="border-transparent bg-transparent px-1.5 py-1 hover:border-transparent focus:bg-transparent"
        />

        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                intake(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              disabled={disabled || busy}
              aria-label="Attach a file"
              onClick={() => {
                inputRef.current?.click();
              }}
            >
              {reading ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Paperclip aria-hidden="true" className="size-4" />
              )}
            </Button>
            <span className="hidden text-[0.6875rem] text-text-subtle sm:inline">
              Enter to send · Shift + Enter for a new line
            </span>
          </div>

          {busy ? (
            <Button variant="secondary" size="icon" aria-label="Stop generating" onClick={onStop}>
              <Square aria-hidden="true" className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button size="icon" aria-label="Send message" disabled={!canSend} onClick={submit}>
              <ArrowUp aria-hidden="true" className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-card border border-dashed border-accent bg-surface-2/80 text-sm font-medium text-accent">
          Drop to attach
        </div>
      )}

      {rejections.length > 0 && (
        <ul role="alert" className="mt-2 flex flex-col gap-0.5">
          {rejections.map((rejection) => (
            <li key={`${rejection.name}-${rejection.reason}`} className="text-xs text-danger-text">
              {rejection.name}: {rejection.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
