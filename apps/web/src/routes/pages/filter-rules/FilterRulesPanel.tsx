import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type { FilterRule, SortDirection } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { ConfirmDialog } from '@web/components/ui/Dialog.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { Switch } from '@web/components/ui/Switch.tsx';
import {
  DataTable,
  type DataTableColumn,
  type SortState,
} from '@web/components/patterns/DataTable.tsx';
import { ListToolbar } from '@web/components/patterns/ListToolbar.tsx';
import { useDeleteFilterRule, useFilterRules, useUpdateFilterRule } from '@web/hooks/use-routing.ts';
import { useUrlParam, useUrlText } from '@web/hooks/use-url-state.ts';
import { formatCount, formatRelative } from '@web/lib/format.ts';
import {
  ENABLED_FILTERS,
  ENABLED_OPTIONS,
  isEnabledFilter,
  matchesEnabled,
  type EnabledFilter,
  type ListCount,
} from '@web/lib/list-filters.ts';

import { FilterRuleDialog } from './FilterRuleDialog.tsx';
import {
  DEFAULT_FILTER_SORT,
  FILTER_ACTION_LABELS,
  FILTER_ACTION_TONES,
  FILTER_DIRECTIONS,
  FILTER_PAGE_SIZE,
  FILTER_SORT_KEYS,
  filterNarrowed,
  isFilterDirection,
  isFilterSortKey,
  phaseLabel,
  type FilterSortKey,
} from './rules.ts';

/**
 * Content filters: the rules the router runs on every request.
 *
 * These rows are not a pool to draw from — they are configuration, and a wrong
 * one is felt by every caller immediately. So the table leads with the pattern,
 * keeps the action as a word rather than a colour alone, and puts the switch that
 * disables a rule in the rule's own row, so turning one off never means opening a
 * dialog.
 *
 * The state filter runs in the browser while the search runs on the server. That
 * split is the endpoint's shape rather than a preference: the list route narrows
 * on `q` and nothing else, and rules are a short list somebody maintains by hand.
 */

/** How many placeholder rows to draw while the first page is in flight. */
const SKELETON_ROWS = 6;

/** Seven columns, in the order `filterColumns` declares them. */
const SKELETON_COLUMN_WIDTHS = ['w-32', 'w-20', 'w-48', 'w-16', 'w-24', 'w-10', 'w-16'];

const ICON_ACTION =
  'rounded-control p-1.5 text-text-muted transition-colors duration-(--dur-micro) ease-out outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-45';

function TableSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading filter rules" className="@container">
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

interface ColumnOptions {
  readonly toggling: boolean;
  readonly deleting: boolean;
  readonly onToggle: (rule: FilterRule, enabled: boolean) => void;
  readonly onEdit: (rule: FilterRule) => void;
  readonly onDelete: (rule: FilterRule) => void;
}

function filterColumns({
  toggling,
  deleting,
  onToggle,
  onEdit,
  onDelete,
}: ColumnOptions): readonly DataTableColumn<FilterRule>[] {
  return [
    {
      id: 'name',
      header: 'Rule',
      sortKey: 'name',
      cell: (row) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm text-text" title={row.name}>
            {row.name}
          </span>
          <span className="truncate text-[0.6875rem] text-text-subtle">
            updated {formatRelative(row.updatedAt)}
          </span>
        </span>
      ),
    },
    {
      id: 'kind',
      header: 'Match',
      widthClassName: 'w-24',
      hideBelow: 'md',
      cell: (row) => (
        <Badge tone="neutral" size="sm">
          {row.kind === 'regex' ? 'Regex' : 'Exact'}
        </Badge>
      ),
    },
    {
      id: 'pattern',
      header: 'Pattern',
      cell: (row) => (
        <span className="block truncate font-mono text-xs text-text-muted" title={row.pattern}>
          {row.pattern}
        </span>
      ),
    },
    {
      id: 'action',
      header: 'Action',
      sortKey: 'action',
      widthClassName: 'w-24',
      cell: (row) => (
        <Badge tone={FILTER_ACTION_TONES[row.action]} size="sm">
          {FILTER_ACTION_LABELS[row.action]}
        </Badge>
      ),
    },
    {
      id: 'phase',
      header: 'Phase',
      sortKey: 'phase',
      widthClassName: 'w-40',
      hideBelow: 'lg',
      cell: (row) => <span className="text-xs text-text-muted">{phaseLabel(row.phase)}</span>,
    },
    {
      id: 'enabled',
      header: 'Enabled',
      widthClassName: 'w-20',
      align: 'end',
      cell: (row) => (
        <Switch
          checked={row.enabled}
          disabled={toggling}
          aria-label={`${row.enabled ? 'Disable' : 'Enable'} the rule ${row.name}`}
          onCheckedChange={(checked) => {
            onToggle(row, checked);
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
            className={ICON_ACTION}
            onClick={() => {
              onEdit(row);
            }}
            aria-label={`Edit ${row.name}`}
            title="Edit"
          >
            <Pencil aria-hidden="true" className="size-3.5" />
          </button>
          <button
            type="button"
            className={ICON_ACTION}
            disabled={deleting}
            onClick={() => {
              onDelete(row);
            }}
            aria-label={`Delete ${row.name}`}
            title="Delete"
          >
            <Trash2 aria-hidden="true" className="size-3.5" />
          </button>
        </span>
      ),
    },
  ];
}

export function FilterRulesPanel() {
  const [search, setSearch] = useUrlText('flt_q');
  const [enabled, setEnabled] = useUrlParam<EnabledFilter>(
    'flt_enabled',
    'all',
    ENABLED_FILTERS,
  );
  const [sort, setSort] = useUrlParam<FilterSortKey>(
    'flt_sort',
    DEFAULT_FILTER_SORT,
    FILTER_SORT_KEYS,
  );
  const [direction, setDirection] = useUrlParam<SortDirection>('flt_dir', 'desc', FILTER_DIRECTIONS);

  const [editing, setEditing] = useState<FilterRule | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleting, setDeleting] = useState<FilterRule | null>(null);
  const [focusTarget, setFocusTarget] = useState<HTMLElement | null>(null);

  const rules = useFilterRules({ q: search, sort, direction, limit: FILTER_PAGE_SIZE });
  const toggle = useUpdateFilterRule();
  const remove = useDeleteFilterRule();

  const all = (rules.data?.pages ?? []).flatMap((page) => page.items);
  const total = rules.data?.pages[0]?.total ?? null;
  const rows = all.filter((rule) => matchesEnabled(rule.enabled, enabled));
  const narrowed = filterNarrowed(search, enabled);

  const count: ListCount = rules.isPending
    ? { kind: 'loading' }
    : rules.isError
      ? { kind: 'error' }
      : { kind: 'ready', shown: rows.length, total: total ?? rows.length };

  const clearFilters = () => {
    setSearch('');
    setEnabled('all');
  };

  const handleSortChange = (next: SortState) => {
    if (next.key !== null && isFilterSortKey(next.key)) setSort(next.key);
    if (isFilterDirection(next.direction)) setDirection(next.direction);
  };

  const rememberFocus = () => {
    setFocusTarget(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  };

  const openNew = () => {
    rememberFocus();
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (rule: FilterRule) => {
    rememberFocus();
    setEditing(rule);
    setFormOpen(true);
  };

  const openDelete = (rule: FilterRule) => {
    rememberFocus();
    setDeleting(rule);
  };

  const toolbar = (
    <ListToolbar
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search name or pattern…"
      filters={[
        {
          value: enabled,
          options: ENABLED_OPTIONS,
          onChange: (next) => {
            if (isEnabledFilter(next)) setEnabled(next);
          },
          label: 'Filter by state',
          widthClassName: '@[480px]:w-40',
        },
      ]}
      count={count}
      noun={{ one: 'rule', many: 'rules' }}
      narrowed={narrowed}
      onClear={clearFilters}
    />
  );

  const status = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {remove.isError || toggle.isError ? (
        <p role="alert" className="text-xs text-danger-text">
          {remove.isError
            ? 'The rule was not deleted. It is still active.'
            : 'The change was not saved. The rule is as it was.'}
        </p>
      ) : (
        <p role="status" aria-live="polite" className="text-xs text-text-muted">
          Rules run in the order listed. A blocking rule stops the request before it reaches a
          provider; a redacting rule rewrites the part that matched.
        </p>
      )}
      <Button size="sm" onClick={openNew}>
        <Plus aria-hidden="true" className="size-3.5" />
        New rule
      </Button>
    </div>
  );

  if (rules.isPending) {
    return (
      <div className="flex flex-col gap-4">
        {status}
        {toolbar}
        <TableSkeleton />
      </div>
    );
  }

  if (rules.isError) {
    return (
      <div className="flex flex-col gap-4">
        {status}
        {toolbar}
        <Card>
          <StateView
            kind="error"
            title="Could not load the filter rules"
            description="The console API did not answer. Check that the server is running, then try again."
            action={
              <Button
                variant="secondary"
                size="sm"
                loading={rules.isFetching}
                onClick={() => {
                  void rules.refetch();
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
      {status}
      {toolbar}

      <DataTable
        rows={rows}
        columns={filterColumns({
          toggling: toggle.isPending,
          deleting: remove.isPending,
          onToggle: (rule, next) => {
            toggle.mutate({ id: rule.id, patch: { enabled: next } });
          },
          onEdit: openEdit,
          onDelete: openDelete,
        })}
        getRowId={(row) => row.id}
        caption="Content filter rules"
        sort={{ key: sort, direction }}
        onSortChange={handleSortChange}
        emptyState={
          <StateView
            kind={narrowed ? 'no-results' : 'empty'}
            title={narrowed ? 'No rules match' : 'No filter rules'}
            description={
              narrowed
                ? 'Nothing here matches these filters. Widen them, or clear the search.'
                : 'With no rules the router passes every request through untouched. Add one to block or redact something before it reaches a provider.'
            }
            action={
              narrowed ? (
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : (
                <Button size="sm" onClick={openNew}>
                  New rule
                </Button>
              )
            }
          />
        }
        footer={
          rules.hasNextPage ? (
            <div className="flex justify-center py-1">
              <Button
                variant="secondary"
                size="sm"
                loading={rules.isFetchingNextPage}
                onClick={() => {
                  void rules.fetchNextPage();
                }}
              >
                Load more
                <span className="tabular-nums text-text-muted">
                  ({formatCount(rows.length)} of {formatCount(total ?? rows.length)})
                </span>
              </Button>
            </div>
          ) : (
            <p className="py-1 text-center text-xs tabular-nums text-text-subtle">
              {formatCount(rows.length)} of {formatCount(total ?? rows.length)} rules
            </p>
          )
        }
      />

      <FilterRuleDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        rule={editing}
        restoreFocusTo={focusTarget}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete this rule?"
        description={
          deleting === null
            ? undefined
            : `${deleting.name} stops running on the next request. This cannot be undone.`
        }
        confirmLabel="Delete rule"
        destructive
        onConfirm={() => {
          if (deleting === null) return;
          remove.mutate(deleting.id, {
            onSuccess: () => {
              setDeleting(null);
            },
          });
        }}
      />
    </div>
  );
}
