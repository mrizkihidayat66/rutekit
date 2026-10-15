import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { Button } from '@web/components/ui/Button.tsx';
import { Checkbox } from '@web/components/ui/Checkbox.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { cn } from '@web/lib/cn.ts';

import { newEntryDraft, parseWeight, type EntryDraft } from './combos.ts';

/**
 * A combo's chain, as an ordered list of editable rows.
 *
 * Order is the whole meaning of a sequential combo and a real input to a weighted
 * one, so the list has to be reorderable and the operator has to be able to see
 * the order at a glance. Hence the numbered gutter: the position is stated rather
 * than implied by vertical placement, which matters the moment a row is being
 * dragged or the list is read on a narrow screen.
 *
 * Reordering works two ways on purpose. A pointer drags the grip, which is what
 * the grip looks like it does. The same control also answers to the arrow keys
 * while focused, which is what makes the list operable without a mouse (R4.9) —
 * and it is announced through a live region, because a sighted keyboard user can
 * see the row move but a screen-reader user cannot.
 *
 * The drop target is computed from the rows' real rectangles rather than from an
 * assumed row height. Rows wrap to two lines on a narrow screen, so any fixed
 * stride would put the drop in the wrong place exactly where the layout is
 * hardest to reason about.
 */

export interface EntryListProps {
  readonly entries: readonly EntryDraft[];
  readonly providerOptions: readonly { readonly value: string; readonly label: string }[];
  /** True when the strategy reads the weight, so the field can be explained. */
  readonly weighted: boolean;
  readonly onChange: (entries: EntryDraft[]) => void;
}

const ROW =
  'flex flex-wrap items-center gap-2 rounded-control border border-border bg-surface-2/40 p-2 transition-colors duration-(--dur-micro) ease-out';

const GRIP =
  'flex size-7 shrink-0 touch-none cursor-grab items-center justify-center rounded-control text-text-muted outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus active:cursor-grabbing';

const ICON_ACTION =
  'rounded-control p-1.5 text-text-muted transition-colors duration-(--dur-micro) ease-out outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus';

export function EntryList({ entries, providerOptions, weighted, onChange }: EntryListProps) {
  const listRef = useRef<HTMLUListElement>(null);
  /** The grips, by row key, so a row can be found after the order has changed. */
  const gripRefs = useRef(new Map<string, HTMLButtonElement>());
  /** The index being dragged, or null. Held in state so the row can render lifted. */
  const [dragging, setDragging] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  /** The row to focus once a reorder has been committed. */
  const [focusKey, setFocusKey] = useState<string | null>(null);

  /**
   * Focus is applied here rather than at the point of the move, because the two
   * cannot happen in the same tick. `onChange` only schedules the new order; until
   * React commits it the DOM still holds the old one, so a lookup by position
   * finds the row that is about to be displaced — and the operator, pressing the
   * arrow again, moves that row instead of the one they were holding. A row's key
   * survives the reorder, so the focus is requested by key and applied once the
   * new order is on screen.
   */
  useEffect(() => {
    if (focusKey === null) return;
    gripRefs.current.get(focusKey)?.focus();
    setFocusKey(null);
  }, [focusKey]);

  const announce = (index: number) => {
    setAnnouncement(`Entry moved to position ${String(index + 1)} of ${String(entries.length)}.`);
  };

  /** Reorders, returning the key of the row that moved so it can keep focus. */
  const move = (from: number, to: number): string | undefined => {
    if (to < 0 || to >= entries.length || from === to) return undefined;
    const next = [...entries];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return undefined;
    next.splice(to, 0, moved);
    onChange(next);
    return moved.key;
  };

  const patch = (index: number, changes: Partial<EntryDraft>) => {
    onChange(entries.map((entry, at) => (at === index ? { ...entry, ...changes } : entry)));
  };

  const remove = (index: number) => {
    onChange(entries.filter((_entry, at) => at !== index));
    setAnnouncement(`Entry removed. ${String(entries.length - 1)} left.`);
  };

  /**
   * Where the pointer currently wants the dragged row to land.
   *
   * Count the rows whose midpoint sits above the pointer: that is how many rows
   * belong before it. Removing the dragged row from the list first shifts that
   * count down by one whenever the row was above the pointer's row.
   */
  const targetFor = (index: number, clientY: number): number => {
    const list = listRef.current;
    if (list === null) return index;
    let before = 0;
    for (const row of Array.from(list.children)) {
      const rect = row.getBoundingClientRect();
      if (rect.top + rect.height / 2 < clientY) before += 1;
    }
    const insertion = before > index ? before - 1 : before;
    return Math.min(Math.max(insertion, 0), entries.length - 1);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, index: number) => {
    // Stop the browser selecting text across the list as the pointer travels.
    event.preventDefault();
    // Capture keeps the move events coming while the pointer is outside the grip.
    // It is an enhancement rather than the drag itself, and the browser refuses it
    // when the pointer is no longer active — which must not take the drag with it.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The grip's own move events still drive the drag.
    }
    setDragging(index);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragging === null) return;
    const next = targetFor(dragging, event.clientY);
    if (next === dragging) return;
    if (move(dragging, next) !== undefined) setDragging(next);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragging === null) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    announce(dragging);
    setDragging(null);
    // The drag suppressed the default focus, so put it back on the grip: the
    // operator who just dragged is very often the one who wants to nudge next.
    event.currentTarget.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const to = index + step;
    const moved = move(index, to);
    if (moved === undefined) return;
    announce(to);
    // Focus follows the row rather than the position, so a second press keeps
    // moving the entry the operator is holding on to.
    setFocusKey(moved);
  };

  const add = () => {
    onChange([...entries, newEntryDraft()]);
  };

  return (
    <div className="flex flex-col gap-2">
      <ul ref={listRef} className="flex flex-col gap-2">
        {entries.map((entry, index) => (
          <li
            key={entry.key}
            className={cn(ROW, dragging === index && 'border-focus bg-surface-3 shadow-popover')}
          >
            <button
              type="button"
              ref={(node) => {
                if (node === null) gripRefs.current.delete(entry.key);
                else gripRefs.current.set(entry.key, node);
              }}
              className={GRIP}
              aria-label={`Reorder entry ${String(index + 1)} of ${String(entries.length)}`}
              onPointerDown={(event) => {
                onPointerDown(event, index);
              }}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={(event) => {
                onKeyDown(event, index);
              }}
            >
              <GripVertical aria-hidden="true" className="size-4" />
            </button>

            <span
              className="w-4 shrink-0 text-center text-xs tabular-nums text-text-subtle"
              aria-hidden="true"
            >
              {index + 1}
            </span>

            <Input
              value={entry.model}
              aria-label={`Model for entry ${String(index + 1)}`}
              placeholder="vendor/model-name"
              autoComplete="off"
              spellCheck={false}
              className="min-w-[9rem] flex-1 font-mono"
              onChange={(event) => {
                patch(index, { model: event.target.value });
              }}
            />

            <SimpleSelect
              value={entry.providerId}
              aria-label={`Provider for entry ${String(index + 1)}`}
              placeholder="Any provider"
              size="sm"
              className="w-[9.5rem]"
              options={[...providerOptions]}
              onValueChange={(value) => {
                patch(index, { providerId: value });
              }}
            />

            <Input
              type="number"
              inputMode="numeric"
              min={1}
              step="1"
              value={entry.weight}
              aria-label={`Weight for entry ${String(index + 1)}`}
              invalid={parseWeight(entry.weight) === undefined}
              className="w-16 tabular-nums"
              onChange={(event) => {
                patch(index, { weight: event.target.value });
              }}
            />

            <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-text-muted">
              <Checkbox
                checked={entry.enabled}
                aria-label={`Entry ${String(index + 1)} enabled`}
                onChange={(event) => {
                  patch(index, { enabled: event.target.checked });
                }}
              />
              On
            </label>

            <button
              type="button"
              aria-label={`Remove entry ${String(index + 1)}`}
              className={cn(ICON_ACTION, 'ml-auto hover:text-danger')}
              onClick={() => {
                remove(index);
              }}
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>

      <p className="text-[0.6875rem] text-text-subtle">
        {weighted
          ? 'Weight decides how much of the traffic each entry takes.'
          : 'Order is the fallback order. Weight only applies to round robin.'}{' '}
        Drag a grip to reorder, or focus one and press ↑ / ↓.
      </p>

      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={add}>
          <Plus aria-hidden="true" className="size-3.5" />
          Add entry
        </Button>
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
