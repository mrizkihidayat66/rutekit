import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import type { LogEntry, LogKind, LogLevel } from '@contracts';

import { cn } from '@web/lib/cn.ts';
import { formatClock } from '@web/lib/format.ts';

import { TONE_LABEL, type Tone } from './tone.ts';

/**
 * The Console Log stream.
 *
 * A log is read differently from a table: it is dense, it grows, and the eye
 * scans a column of colours before it reads a word. So this is its own surface
 * (`terminal-surface`, monospace, recessed) rather than a `DataTable`, and the
 * per-kind colour is on the row's leading edge so the kind of a line is legible
 * from the shape of the column alone.
 *
 * Responsiveness is by container query (RULESET R3.6) and drops the least
 * useful columns first — account, then provider, then request id — because the
 * pane sits beside a sidebar on desktop and full-width on a phone, and the
 * viewport width says nothing about how much room the log actually has.
 *
 * A line that arrives while the operator is watching is flashed once. The flash
 * is a token animation, so `prefers-reduced-motion` turns it off without any
 * branch in the component (RULESET R3.7).
 */

export interface LogViewerProps {
  readonly entries: readonly LogEntry[];
  readonly getRowId?: (entry: LogEntry) => string;
  readonly onSelect?: (entry: LogEntry) => void;
  /**
   * Which lines offer selection. A line the page cannot act on must not look
   * clickable, so the cursor and the tab stop follow this rather than `onSelect`
   * alone — a log line with no request behind it has nothing to open.
   */
  readonly isSelectable?: (entry: LogEntry) => boolean;
  readonly activeId?: string | null;
  readonly emptyState?: ReactNode;
  readonly className?: string;
}

const KIND_TONE: Record<LogKind, Tone> = {
  route: 'accent',
  account: 'info',
  token: 'success',
  error: 'danger',
  system: 'warning',
};

const LEVEL_TONE: Record<LogLevel, Tone> = {
  debug: 'neutral',
  info: 'info',
  warn: 'warning',
  error: 'danger',
};

/** How long a newly arrived line stays flashed; matches `--dur-slow` plus slack. */
const FLASH_MS = 520;

const defaultRowId = (entry: LogEntry): string => entry.id;

/** Every line is selectable unless the page narrows it. */
const selectableByDefault = (): boolean => true;

export function LogViewer({
  entries,
  getRowId = defaultRowId,
  onSelect,
  isSelectable = selectableByDefault,
  activeId = null,
  emptyState,
  className,
}: LogViewerProps) {
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(() => new Set());
  const seen = useRef<Set<string>>(new Set());
  const initialised = useRef(false);

  useEffect(() => {
    const ids = entries.map(getRowId);
    if (!initialised.current) {
      initialised.current = true;
      seen.current = new Set(ids);
      return;
    }
    const fresh = ids.filter((id) => !seen.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) seen.current.add(id);
    setFlashing(new Set(fresh));
    const timer = setTimeout(() => {
      setFlashing(new Set());
    }, FLASH_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [entries, getRowId]);

  const handleKey = (event: KeyboardEvent<HTMLDivElement>, entry: LogEntry) => {
    if (onSelect === undefined) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(entry);
    }
  };

  return (
    <div className={cn('@container', className)}>
      <div className="terminal-surface overflow-hidden">
        <div className="flex items-center gap-3 border-b border-border px-3 py-1.5 font-mono text-[0.625rem] uppercase tracking-wide text-text-subtle">
          <span className="w-[4.5rem] shrink-0">time</span>
          <span className="w-11 shrink-0">level</span>
          <span className="w-14 shrink-0">kind</span>
          <span className="min-w-0 flex-1">message</span>
          <span className="hidden w-24 shrink-0 @[620px]:inline">request</span>
          <span className="hidden w-24 shrink-0 @[720px]:inline">provider</span>
          <span className="hidden w-24 shrink-0 @[900px]:inline">account</span>
        </div>

        {entries.length === 0 ? (
          <div className="px-3 py-12 text-center text-xs text-text-muted">
            {emptyState ?? 'No log lines match the current filters.'}
          </div>
        ) : (
          <div role="list" className="max-h-[calc(100vh_-_16rem)] overflow-y-auto">
            {entries.map((entry) => {
              const id = getRowId(entry);
              const interactive = onSelect !== undefined && isSelectable(entry);
              return (
                <div
                  key={id}
                  role="listitem"
                  tabIndex={interactive ? 0 : undefined}
                  aria-current={id === activeId ? 'true' : undefined}
                  onClick={
                    interactive
                      ? () => {
                          onSelect(entry);
                        }
                      : undefined
                  }
                  onKeyDown={(event) => {
                    handleKey(event, entry);
                  }}
                  className={cn(
                    'flex items-start gap-3 border-b border-border/50 px-3 py-1.5 font-mono text-[0.6875rem] leading-relaxed outline-none last:border-0',
                    interactive && 'cursor-pointer hover:bg-surface-2/60 focus-visible:bg-surface-2',
                    id === activeId && 'bg-accent/8',
                    flashing.has(id) && 'animate-flash',
                  )}
                >
                  <span className="w-[4.5rem] shrink-0 tabular-nums text-text-subtle">
                    {formatClock(entry.at)}
                  </span>
                  <span
                    className={cn('w-11 shrink-0 uppercase', TONE_LABEL[LEVEL_TONE[entry.level]])}
                  >
                    {entry.level}
                  </span>
                  <span className={cn('w-14 shrink-0', TONE_LABEL[KIND_TONE[entry.kind]])}>
                    {entry.kind}
                  </span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-text">
                    {entry.message}
                    {Object.keys(entry.fields).length === 0
                      ? null
                      : Object.entries(entry.fields).map(([key, value]) => (
                          <span key={key} className="ml-2 text-text-subtle">
                            {key}={value}
                          </span>
                        ))}
                  </span>
                  <span className="hidden w-24 shrink-0 truncate text-text-muted @[620px]:inline">
                    {entry.requestId ?? '—'}
                  </span>
                  <span className="hidden w-24 shrink-0 truncate text-text-muted @[720px]:inline">
                    {entry.providerId ?? '—'}
                  </span>
                  <span className="hidden w-24 shrink-0 truncate text-text-muted @[900px]:inline">
                    {entry.accountId ?? '—'}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
