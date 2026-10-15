import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';

import type { SortDirection } from '@contracts';

import { cn } from '@web/lib/cn.ts';

/**
 * The console's one table.
 *
 * Everything tabular in rutekit is a list of rows that can be sorted and, often,
 * opened — the request table, the account list, the API key list. Building that
 * once means sorting is keyboard-operable and correctly announced everywhere
 * rather than only on the page where someone remembered.
 *
 * Two decisions worth stating:
 *
 * - Sortable headers are real `<button>`s inside the `<th>`, and the `<th>`
 *   carries `aria-sort` (RULESET R4.5). A screen reader is told the current
 *   order and can change it; a `onClick` on the `<th>` would do neither.
 * - A row that opens something is focusable and answers to Enter and Space
 *   (RULESET R4.9), so the drawer is reachable without a mouse.
 *
 * Columns drop out below a container width rather than squeezing, because the
 * table is responsive to *its own* box, not the viewport (RULESET R3.6) — it
 * sits beside a sidebar at desktop widths and full-width on a phone.
 *
 * When even the surviving columns do not fit — nine columns on a phone, where
 * the last one carries the row's only control — the table scrolls inside its own
 * frame rather than widening the page. Without the wrapper the table's intrinsic
 * min-content width propagates up to the nearest scroller, which is `<main>`, so
 * dragging the table sideways also drags the page header and toolbar out of view.
 */

export interface DataTableColumn<Row> {
  readonly id: string;
  readonly header: ReactNode;
  /** The field name sent as `?sort=`; omit to make the column unsortable. */
  readonly sortKey?: string;
  readonly align?: 'start' | 'end';
  /** Tailwind width class, e.g. `w-28`. */
  readonly widthClassName?: string;
  /** Drop the column below a container width instead of squeezing it. */
  readonly hideBelow?: 'sm' | 'md' | 'lg';
  readonly headerClassName?: string;
  readonly cellClassName?: string;
  readonly cell: (row: Row) => ReactNode;
}

export interface SortState {
  readonly key: string | null;
  readonly direction: SortDirection;
}

export interface DataTableProps<Row> {
  readonly rows: readonly Row[];
  readonly columns: readonly DataTableColumn<Row>[];
  readonly getRowId: (row: Row) => string;
  /** Accessible name for the table. */
  readonly caption: string;
  readonly sort?: SortState;
  readonly onSortChange?: (next: SortState) => void;
  readonly onRowClick?: (row: Row) => void;
  readonly activeRowId?: string | null;
  /** Shown in place of the body when there are no rows. */
  readonly emptyState?: ReactNode;
  /** Rendered under the table — a "load more" control, a total. */
  readonly footer?: ReactNode;
  readonly rowClassName?: (row: Row) => string | undefined;
  readonly className?: string;
}

const HIDE_BELOW = {
  sm: 'hidden @[640px]:table-cell',
  md: 'hidden @[820px]:table-cell',
  lg: 'hidden @[1024px]:table-cell',
} as const;

function ariaSortFor(column: DataTableColumn<unknown>, sort: SortState | undefined) {
  if (column.sortKey === undefined) return undefined;
  if (sort === undefined || sort.key !== column.sortKey) return 'none' as const;
  return sort.direction === 'asc' ? ('ascending' as const) : ('descending' as const);
}

export function DataTable<Row>({
  rows,
  columns,
  getRowId,
  caption,
  sort,
  onSortChange,
  onRowClick,
  activeRowId = null,
  emptyState,
  footer,
  rowClassName,
  className,
}: DataTableProps<Row>) {
  const handleSort = (sortKey: string) => {
    if (onSortChange === undefined) return;
    if (sort !== undefined && sort.key === sortKey) {
      onSortChange({ key: sortKey, direction: sort.direction === 'asc' ? 'desc' : 'asc' });
      return;
    }
    // A new column starts descending, matching the list endpoints' default.
    onSortChange({ key: sortKey, direction: 'desc' });
  };

  const handleRowKey = (event: KeyboardEvent<HTMLTableRowElement>, row: Row) => {
    if (onRowClick === undefined) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onRowClick(row);
    }
  };

  return (
    <div className={cn('@container', className)}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-border">
              {columns.map((column) => {
                const sorted = ariaSortFor(column as DataTableColumn<unknown>, sort);
                const isSorted = sorted === 'ascending' || sorted === 'descending';
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={sorted}
                    className={cn(
                      'px-3 py-2 text-xs font-medium text-text-muted',
                      column.align === 'end' ? 'text-right' : 'text-left',
                      column.widthClassName,
                      column.hideBelow === undefined ? undefined : HIDE_BELOW[column.hideBelow],
                      column.headerClassName,
                    )}
                  >
                    {column.sortKey === undefined ? (
                      <span className="inline-flex items-center">{column.header}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          handleSort(column.sortKey as string);
                        }}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-key px-1 py-0.5 outline-none transition-colors duration-(--dur-micro) hover:text-text focus-visible:ring-2 focus-visible:ring-focus',
                          isSorted && 'text-text',
                          column.align === 'end' && 'flex-row-reverse',
                        )}
                      >
                        {column.header}
                        {sorted === 'ascending' ? (
                          <ArrowUp aria-hidden="true" className="size-3" />
                        ) : sorted === 'descending' ? (
                          <ArrowDown aria-hidden="true" className="size-3" />
                        ) : (
                          <ChevronsUpDown aria-hidden="true" className="size-3 opacity-50" />
                        )}
                      </button>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-10 text-center text-sm text-text-muted"
                >
                  {emptyState ?? 'Nothing to show.'}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const id = getRowId(row);
                const interactive = onRowClick !== undefined;
                return (
                  <tr
                    key={id}
                    tabIndex={interactive ? 0 : undefined}
                    aria-selected={interactive ? id === activeRowId : undefined}
                    onClick={
                      onRowClick === undefined
                        ? undefined
                        : () => {
                            onRowClick(row);
                          }
                    }
                    onKeyDown={(event) => {
                      handleRowKey(event, row);
                    }}
                    className={cn(
                      'border-b border-border/60 transition-colors duration-(--dur-micro) outline-none last:border-0',
                      interactive &&
                        'cursor-pointer hover:bg-surface-2/70 focus-visible:bg-surface-2',
                      id === activeRowId && 'bg-accent/8',
                      rowClassName?.(row),
                    )}
                  >
                    {columns.map((column) => (
                      <td
                        key={column.id}
                        className={cn(
                          'px-3 py-2 align-middle',
                          column.align === 'end' ? 'text-right' : 'text-left',
                          column.hideBelow === undefined ? undefined : HIDE_BELOW[column.hideBelow],
                          column.cellClassName,
                        )}
                      >
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {footer === undefined ? null : (
        <div className="border-t border-border px-3 py-2">{footer}</div>
      )}
    </div>
  );
}
