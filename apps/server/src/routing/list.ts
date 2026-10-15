import type { ListQuery } from '@contracts';

/**
 * The list shape every Routing screen shares.
 *
 * Three tables with three sort vocabularies, but one paging protocol and one
 * notion of "sort by a field the caller named". Keeping it in one file means the
 * three services cannot drift on what `cursor` means or on how a tie is broken.
 *
 * Sorting happens here rather than in SQL for the same reason `api-keys` does it
 * in memory: the console offers sort keys that are not columns (a combo's entry
 * count, if one is ever added) and an instance holds tens of rows, so a query per
 * sort key would be three `order by` clauses to keep in step with the contract
 * for no gain.
 */

/** Cursors are plain offsets, matching what the console's pager already sends. */
export function offsetOf(cursor: string | null): number {
  if (cursor === null) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** A comparable key: text for labels, a number for the columns that order numerically. */
type SortKey = string | number;

/**
 * Apply the query's sort, or leave the order alone when it named none.
 *
 * An absent `sort` is not "sort by something" — it is the caller saying "your
 * order". Each repository's `list` already returns a defensible one (a mapping
 * list comes back in the order the pipeline runs it), and replacing that with an
 * arbitrary default column would make the console's first render disagree with
 * the order the rules actually execute in.
 *
 * An *unrecognised* `sort` is also left alone rather than refused: the sort key
 * travels as a bare field name, and a page that has not been updated for a column
 * the server renamed should show the natural order, not an error.
 *
 * Ties break on the row id so the order is total: without it, two rows with the
 * same label could swap places between the first page and the second, and a row
 * could be shown twice or skipped entirely.
 *
 * A numeric key compares numerically. Sorting a mapping's `priority` as text
 * would put 10 before 2, which is the one column on this page where the operator
 * has typed a number and would notice.
 */
export function sortRows<TRow>(
  rows: readonly TRow[],
  query: ListQuery,
  sorters: Readonly<Record<string, (row: TRow) => SortKey>>,
  idOf: (row: TRow) => string,
): TRow[] {
  const sorter = sorters[query.sort ?? ''];
  if (sorter === undefined) return [...rows];

  const direction = query.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sorter(a);
    const right = sorter(b);
    if (left === right) return idOf(a).localeCompare(idOf(b));
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right));
    return order * direction;
  });
}

export interface Page<TItem> {
  readonly items: TItem[];
  readonly nextCursor: string | null;
  readonly total: number;
}

/** One page of already-sorted items, plus the cursor that reaches the next one. */
export function paginate<TItem>(
  items: readonly TItem[],
  offset: number,
  limit: number,
): Page<TItem> {
  const next = offset + limit;
  return {
    items: items.slice(offset, next),
    nextCursor: next < items.length ? String(next) : null,
    total: items.length,
  };
}
