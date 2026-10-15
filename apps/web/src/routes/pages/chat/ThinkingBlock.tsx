import { Brain, ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@web/lib/cn.ts';

/**
 * The model's deliberation, folded away.
 *
 * It is open while it is being written and closed once it is finished, which is
 * the only behaviour that makes sense: a reasoning stream is worth watching live
 * — that is the point of a thinking model — but a finished transcript should
 * show the answer, not the working. An operator who wants the working back can
 * open it, and one who opened it by hand keeps it open, because collapsing
 * something a person deliberately expanded is the kind of small rudeness that
 * makes a UI feel like it is fighting you.
 */
export function ThinkingBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? streaming;

  return (
    <div className="rounded-control border border-border bg-surface-2/60">
      <button
        type="button"
        onClick={() => {
          setManual(!open);
        }}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-text-muted transition duration-(--dur-micro) hover:text-text"
      >
        <Brain aria-hidden="true" className={cn('size-3.5 shrink-0', streaming && 'text-accent')} />
        <span className="font-medium">
          {streaming ? 'Thinking' : 'Thought for a moment'}
        </span>
        {streaming && (
          <span aria-hidden="true" className="flex gap-0.5">
            <span className="size-1 rounded-pill bg-current animate-pulse-soft" />
            <span className="size-1 rounded-pill bg-current animate-pulse-soft [animation-delay:150ms]" />
            <span className="size-1 rounded-pill bg-current animate-pulse-soft [animation-delay:300ms]" />
          </span>
        )}
        <ChevronRight
          aria-hidden="true"
          className={cn('ml-auto size-3.5 shrink-0 transition duration-(--dur-micro)', open && 'rotate-90')}
        />
      </button>
      {open && (
        <div className="border-t border-border px-2.5 py-2 text-xs leading-relaxed text-text-muted italic whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}
