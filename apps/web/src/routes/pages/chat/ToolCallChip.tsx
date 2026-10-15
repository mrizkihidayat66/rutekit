import { ChevronRight, Loader2, Wrench } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@web/components/ui/Badge.tsx';
import { cn } from '@web/lib/cn.ts';

/**
 * A tool the model reached for.
 *
 * The interesting state is the one where a call has no result. A transcript that
 * shows "read_file" and nothing else is telling the truth: the model asked, and
 * either the console has not answered yet or the turn ended before it did. Both
 * happen, and neither is an error, so the chip says which one it is rather than
 * pretending the call succeeded.
 */
export interface ToolCallView {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly output: unknown;
  readonly state: 'streaming' | 'running' | 'done' | 'error';
}

const STATE_LABEL: Readonly<Record<ToolCallView['state'], string>> = {
  streaming: 'Preparing',
  running: 'Running',
  done: 'Done',
  error: 'Failed',
};

function render(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    // A tool input can hold something JSON cannot describe — a cycle, or a
    // value with a throwing getter. Saying so beats rendering `[object Object]`.
    return 'This value could not be shown.';
  }
}

export function ToolCallChip({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const pending = call.state === 'streaming' || call.state === 'running';
  const detail = render(call.state === 'done' || call.state === 'error' ? call.output : call.input);

  return (
    <div className="rounded-control border border-border bg-surface-2/60">
      <button
        type="button"
        onClick={() => {
          setOpen((was) => !was);
        }}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition duration-(--dur-micro) hover:text-text"
      >
        {pending ? (
          <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin text-accent" />
        ) : (
          <Wrench aria-hidden="true" className={cn('size-3.5 shrink-0', call.state === 'error' ? 'text-danger' : 'text-text-muted')} />
        )}
        <span className="font-mono text-[0.8125rem] text-text">{call.name}</span>
        <Badge tone={call.state === 'error' ? 'danger' : 'neutral'} size="sm">
          {STATE_LABEL[call.state]}
        </Badge>
        <ChevronRight
          aria-hidden="true"
          className={cn('ml-auto size-3.5 shrink-0 text-text-subtle transition duration-(--dur-micro)', open && 'rotate-90')}
        />
      </button>
      {open && detail !== '' && (
        <pre className="scrollbar-none max-h-64 overflow-auto border-t border-border px-2.5 py-2 font-mono text-[0.75rem] leading-relaxed text-text-muted">
          {detail}
        </pre>
      )}
    </div>
  );
}
