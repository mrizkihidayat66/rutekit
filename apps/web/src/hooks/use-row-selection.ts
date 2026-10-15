import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

/**
 * Row selection for a paged table.
 *
 * The table pages, so "the selection" is a set of ids rather than a slice of a
 * list: a row ticked on the first page stays ticked when the second arrives. The
 * ids are held, not the rows, because the rows are refetched underneath the
 * selection and the operator's intent is about the records, not about objects.
 *
 * Shift-click extends the way every file list does — the range between the
 * anchor and the clicked row joins or leaves together, rather than each row in
 * between flipping on its own. That needs the current row order, which is why
 * `ids` is an argument rather than something the hook could infer from the set.
 *
 * The modifier itself has to be captured separately from the toggle, because a
 * checkbox's `change` event carries no modifier keys — only its `click` does.
 * So the row writes `shiftHeld` on click and the toggle that runs a moment later
 * reads it. The browser's own ordering (click, then change) is what makes one
 * shared flag safe.
 */

export interface RowSelection {
  /** The ticked ids. Pass to a bulk action as-is. */
  readonly selected: ReadonlySet<string>;
  readonly count: number;
  /** Every loaded row is ticked. False when there are no rows. */
  readonly allSelected: boolean;
  /** Some but not all — the select-all box's third state. */
  readonly someSelected: boolean;
  /**
   * Set by a row's `onClick`, read by its `onChange`. The row component owns
   * both handlers, so this is the hand-off between them.
   */
  readonly shiftHeld: RefObject<boolean>;
  toggle: (id: string, options?: { readonly range?: boolean }) => void;
  toggleAll: () => void;
  clear: () => void;
}

export function useRowSelection(ids: readonly string[], resetKey: string): RowSelection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  /** Where a shift-click range starts from. Reset when the selection is. */
  const anchor = useRef<number | null>(null);
  const shiftHeld = useRef(false);

  // A changed filter is a different table, and the rows the operator ticked are
  // no longer the rows on screen. Keeping them would leave the bulk bar counting
  // records nobody can see, and acting on them would be worse.
  useEffect(() => {
    setSelected(new Set<string>());
    anchor.current = null;
    shiftHeld.current = false;
  }, [resetKey]);

  const toggle = useCallback(
    (id: string, options?: { readonly range?: boolean }) => {
      setSelected((previous) => {
        const next = new Set(previous);
        const index = ids.indexOf(id);

        if (options?.range === true && anchor.current !== null && index !== -1) {
          const from = Math.min(anchor.current, index);
          const to = Math.max(anchor.current, index);
          // The clicked row decides the direction: shift-clicking an unticked row
          // adds the range, shift-clicking a ticked one removes it.
          const adding = !previous.has(id);
          for (let cursor = from; cursor <= to; cursor += 1) {
            const rowId = ids[cursor];
            if (rowId === undefined) continue;
            if (adding) next.add(rowId);
            else next.delete(rowId);
          }
        } else if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }

        anchor.current = index === -1 ? null : index;
        return next;
      });
    },
    [ids],
  );

  const allSelected = useMemo(
    () => ids.length > 0 && ids.every((id) => selected.has(id)),
    [ids, selected],
  );

  const someSelected = useMemo(
    () => !allSelected && ids.some((id) => selected.has(id)),
    [ids, selected, allSelected],
  );

  const toggleAll = useCallback(() => {
    setSelected((previous) => {
      const every = ids.length > 0 && ids.every((id) => previous.has(id));
      anchor.current = null;
      return every ? new Set<string>() : new Set(ids);
    });
  }, [ids]);

  const clear = useCallback(() => {
    setSelected(new Set<string>());
    anchor.current = null;
    shiftHeld.current = false;
  }, []);

  return {
    selected,
    count: selected.size,
    allSelected,
    someSelected,
    shiftHeld,
    toggle,
    toggleAll,
    clear,
  };
}
