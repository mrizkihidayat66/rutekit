import { useRef } from 'react';

import { useClock } from '@web/hooks/useClock.ts';
import { cn } from '@web/lib/cn.ts';
import { formatSpan } from '@web/lib/format.ts';

/**
 * Seconds until something refills, counted down locally.
 *
 * The server sends a figure, not a deadline, and refetches are minutes apart, so
 * a clock that only moved on refetch would sit still while the operator watched.
 * Counting from the value it was rendered with — captured once in a ref, so a
 * parent re-render does not restart it — keeps it moving without polling for a
 * number the client can already derive.
 *
 * A `null` schedule is not "resets in 0s"; it is "never resets", which is a
 * different sentence. Callers render that themselves rather than passing null
 * here, so this component never has to invent a phrasing for it.
 */
export function ResetCountdown({
  seconds,
  className,
}: {
  readonly seconds: number;
  readonly className?: string;
}) {
  const startedAt = useRef(Date.now());
  const now = useClock();
  const remaining = Math.max(0, seconds - Math.floor((now.getTime() - startedAt.current) / 1000));
  return (
    <span className={cn('tabular-nums', className)}>
      {remaining === 0 ? 'refilling' : formatSpan(remaining)}
    </span>
  );
}

/**
 * The same countdown, from an absolute deadline rather than a span.
 *
 * A quota window reports *when* it resets, not how long until it does, so the
 * remaining time has to be recomputed each tick against the real clock. That
 * needs no captured start: the deadline does not move, and a refetch that
 * reports the same one changes nothing.
 *
 * What happens at zero depends on what the deadline governs — a quota window
 * refills, a worker's grace period runs out — so the caller supplies the word.
 * Only the caller knows which of those it is holding.
 */
export function ResetDeadline({
  at,
  className,
  zeroLabel = 'refilling',
}: {
  /** ISO timestamp the window resets at. */
  readonly at: string;
  readonly className?: string;
  /** What is true once the deadline has passed. */
  readonly zeroLabel?: string;
}) {
  const now = useClock();
  const remaining = Math.max(0, Math.ceil((Date.parse(at) - now.getTime()) / 1000));
  return (
    <span className={cn('tabular-nums', className)}>
      {remaining === 0 ? zeroLabel : formatSpan(remaining)}
    </span>
  );
}
