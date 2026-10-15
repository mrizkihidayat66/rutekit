import { ArrowRight, Pencil, RefreshCw, Trash2 } from 'lucide-react';

import type { ModelMappingRule, SortDirection } from '@contracts';

import { DataTable, type SortState } from '@web/components/patterns/DataTable.tsx';
import { ListToolbar } from '@web/components/patterns/ListToolbar.tsx';
import { Badge, type BadgeTone } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { Switch } from '@web/components/ui/Switch.tsx';
import { useMappings } from '@web/hooks/use-routing.ts';
import { cn } from '@web/lib/cn.ts';
import { formatCount, formatRelative } from '@web/lib/format.ts';
import {
  ENABLED_OPTIONS,
  isEnabledFilter,
  listNarrowed,
  matchesEnabled,
  type EnabledFilter,
  type ListCount,
} from '@web/lib/list-filters.ts';

import { MAPPING_PAGE_SIZE, MATCH_LABELS } from './mapping.ts';

/**
 * The rewrite list.
 *
 * Priority leads the table because it is the rule's meaning, not its metadata:
 * the rules are tried lowest-first and the first one that matches wins, so the
 * column that orders the list is the column that decides what happens. An
 * operator scanning this table is asking "what will `gpt-4-turbo` become", and
 * the answer is read top to bottom.
 *
 * The pattern and its replacement sit in one column, joined by an arrow, because
 * they are one statement — a rule that shows only the pattern cannot be checked
 * without opening it.
 */

/** How many placeholder rows to draw while the first page is in flight. */
const SKELETON_ROWS = 6;

/** Seven columns, in the order declared below. */
const SKELETON_COLUMN_WIDTHS = ['w-10', 'w-16', 'w-52', 'w-40', 'w-16', 'w-10', 'w-12'];

const ICON_ACTION =
  'rounded-control p-1.5 text-text-muted transition-colors duration-(--dur-micro) ease-out outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus';

/** Regex is the sharpest tool here, so it is the one the badge draws attention to. */
const MATCH_TONES: Record<ModelMappingRule['match'], BadgeTone> = {
  exact: 'info',
  contains: 'neutral',
  regex: 'accent',
};

function TableSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading mapping rules" className="@container">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border">
              {SKELETON_COLUMN_WIDTHS.map((width, index) => (
                <th key={index} scope="col" className="px-3 py-2 text-left">
                  <Skeleton shape="text" className={width} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: SKELETON_ROWS }, (_, rowIndex) => (
              <tr key={rowIndex} className="border-b border-border/60 last:border-0">
                {SKELETON_COLUMN_WIDTHS.map((width, cellIndex) => (
                  <td key={cellIndex} className="px-3 py-2.5">
                    <Skeleton shape="text" className={width} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export interface RulesTableProps {
  readonly search: string;
  readonly enabled: EnabledFilter;
  readonly sort: string;
  readonly direction: SortDirection;
  readonly onSearchChange: (value: string) => void;
  readonly onEnabledChange: (value: EnabledFilter) => void;
  readonly onClearFilters: () => void;
  readonly onSortChange: (next: SortState) => void;
  readonly onEdit: (rule: ModelMappingRule) => void;
  readonly onDelete: (rule: ModelMappingRule) => void;
  readonly onToggleEnabled: (rule: ModelMappingRule, enabled: boolean) => void;
  readonly onNew: () => void;
}

export function RulesTable({
  search,
  enabled,
  sort,
  direction,
  onSearchChange,
  onEnabledChange,
  onClearFilters,
  onSortChange,
  onEdit,
  onDelete,
  onToggleEnabled,
  onNew,
}: RulesTableProps) {
  const mappings = useMappings({ q: search, sort, direction, limit: MAPPING_PAGE_SIZE });
  const all = (mappings.data?.pages ?? []).flatMap((page) => page.items);
  const total = mappings.data?.pages[0]?.total ?? null;
  const rows = all.filter((rule) => matchesEnabled(rule.enabled, enabled));
  const narrowed = listNarrowed(search, enabled);

  const count: ListCount = mappings.isPending
    ? { kind: 'loading' }
    : mappings.isError
      ? { kind: 'error' }
      : { kind: 'ready', shown: rows.length, total: total ?? rows.length };

  const toolbar = (
    <ListToolbar
      search={search}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search pattern, replacement or note…"
      filters={[
        {
          value: enabled,
          options: ENABLED_OPTIONS,
          onChange: (next) => {
            if (isEnabledFilter(next)) onEnabledChange(next);
          },
          label: 'Filter by state',
        },
      ]}
      count={count}
      noun={{ one: 'rule', many: 'rules' }}
      narrowed={listNarrowed(search, enabled)}
      onClear={onClearFilters}
    />
  );

  if (mappings.isPending) {
    return (
      <div className="flex flex-col gap-4">
        {toolbar}
        <TableSkeleton />
      </div>
    );
  }

  if (mappings.isError) {
    return (
      <div className="flex flex-col gap-4">
        {toolbar}
        <Card>
          <StateView
            kind="error"
            title="Could not load the mapping rules"
            description="The console API did not answer. Check that the server is running, then try again."
            action={
              <Button
                variant="secondary"
                size="sm"
                loading={mappings.isFetching}
                onClick={() => {
                  void mappings.refetch();
                }}
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
                Retry
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {toolbar}
      <DataTable
        rows={rows}
        getRowId={(row) => row.id}
        caption="Model mapping rules, tried in ascending priority"
        sort={{ key: sort, direction }}
        onSortChange={onSortChange}
        columns={[
          {
            id: 'priority',
            header: 'Runs',
            sortKey: 'priority',
            align: 'end',
            widthClassName: 'w-16',
            headerClassName: 'text-right',
            cell: (row) => (
              <span
                className={cn(
                  'font-mono tabular-nums',
                  row.enabled ? 'text-text' : 'text-text-subtle',
                )}
                title={`Priority ${String(row.priority)}`}
              >
                {row.priority}
              </span>
            ),
          },
          {
            id: 'match',
            header: 'Match',
            hideBelow: 'sm',
            cell: (row) => (
              <Badge tone={MATCH_TONES[row.match]} size="sm">
                {MATCH_LABELS[row.match]}
              </Badge>
            ),
          },
          {
            id: 'rule',
            header: 'Rule',
            cell: (row) => (
              <span
                className={cn('flex min-w-0 items-center gap-1.5', !row.enabled && 'opacity-45')}
              >
                <span
                  className="max-w-[18rem] truncate rounded-key bg-surface-2/60 px-1.5 py-0.5 font-mono text-[0.6875rem] text-text"
                  title={row.pattern}
                >
                  {row.pattern}
                </span>
                <ArrowRight aria-hidden="true" className="size-3 shrink-0 text-text-subtle" />
                {row.replacement === '' ? (
                  <span className="text-[0.6875rem] text-text-subtle">empty string</span>
                ) : (
                  <span
                    className="max-w-[16rem] truncate rounded-key bg-surface-2/60 px-1.5 py-0.5 font-mono text-[0.6875rem] text-text-muted"
                    title={row.replacement}
                  >
                    {row.replacement}
                  </span>
                )}
              </span>
            ),
          },
          {
            id: 'description',
            header: 'Note',
            hideBelow: 'lg',
            cell: (row) => (
              <span
                className="block max-w-[20rem] truncate text-xs text-text-muted"
                title={row.description ?? undefined}
              >
                {row.description ?? '—'}
              </span>
            ),
          },
          {
            id: 'updated',
            header: 'Updated',
            sortKey: 'updatedAt',
            align: 'end',
            hideBelow: 'lg',
            cell: (row) => <span className="text-text-muted">{formatRelative(row.updatedAt)}</span>,
          },
          {
            id: 'enabled',
            header: 'Enabled',
            widthClassName: 'w-20',
            align: 'end',
            cell: (row) => (
              <Switch
                checked={row.enabled}
                aria-label={`${row.enabled ? 'Disable' : 'Enable'} the rule for ${row.pattern}`}
                onCheckedChange={(checked) => {
                  onToggleEnabled(row, checked);
                }}
              />
            ),
          },
          {
            id: 'actions',
            header: <span className="sr-only">Actions</span>,
            align: 'end',
            widthClassName: 'w-20',
            cell: (row) => (
              <span className="inline-flex items-center gap-0.5">
                <button
                  type="button"
                  aria-label={`Edit the rule for ${row.pattern}`}
                  className={ICON_ACTION}
                  onClick={() => {
                    onEdit(row);
                  }}
                >
                  <Pencil aria-hidden="true" className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Delete the rule for ${row.pattern}`}
                  className={cn(ICON_ACTION, 'hover:text-danger')}
                  onClick={() => {
                    onDelete(row);
                  }}
                >
                  <Trash2 aria-hidden="true" className="size-3.5" />
                </button>
              </span>
            ),
          },
        ]}
        emptyState={
          <StateView
            kind={narrowed ? 'no-results' : 'empty'}
            title={narrowed ? 'No rules match' : 'No rewrite rules yet'}
            description={
              narrowed
                ? 'Nothing here matches these filters. Widen them, or clear the search.'
                : 'A rule rewrites the model id a client sends before anything else looks at it. Add one when a provider retires a name and you would rather not chase every caller.'
            }
            action={
              narrowed ? (
                <Button variant="secondary" size="sm" onClick={onClearFilters}>
                  Clear filters
                </Button>
              ) : (
                <Button size="sm" onClick={onNew}>
                  New rule
                </Button>
              )
            }
          />
        }
        footer={
          mappings.hasNextPage ? (
            <div className="flex justify-center py-1">
              <Button
                variant="secondary"
                size="sm"
                loading={mappings.isFetchingNextPage}
                onClick={() => {
                  void mappings.fetchNextPage();
                }}
              >
                Load more
                <span className="tabular-nums text-text-muted">
                  ({formatCount(all.length)} of {formatCount(total ?? all.length)})
                </span>
              </Button>
            </div>
          ) : (
            <p className="py-1 text-center text-xs tabular-nums text-text-subtle">
              {formatCount(rows.length)} of {formatCount(total ?? rows.length)} rules, tried in
              ascending priority
            </p>
          )
        }
      />
    </div>
  );
}
