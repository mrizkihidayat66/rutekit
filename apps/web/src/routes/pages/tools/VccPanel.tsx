import { CreditCard, Pencil, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import type { SortDirection, VccCard } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { DataTable, type DataTableColumn, type SortState } from '@web/components/patterns/DataTable.tsx';
import { ListToolbar } from '@web/components/patterns/ListToolbar.tsx';
import { useVccCards } from '@web/hooks/use-tools.ts';
import { useUrlParam, useUrlText } from '@web/hooks/use-url-state.ts';
import { formatCount, formatRelative } from '@web/lib/format.ts';
import type { ListCount } from '@web/lib/list-filters.ts';

import { GenerateVccDialog } from './GenerateVccDialog.tsx';
import { VccCardDialog } from './VccCardDialog.tsx';
import {
  DEFAULT_VCC_SORT,
  VCC_BRANDS,
  VCC_BRAND_FILTERS,
  VCC_BRAND_LABELS,
  VCC_DIRECTIONS,
  VCC_PAGE_SIZE,
  VCC_SORT_KEYS,
  VCC_STATUSES,
  VCC_STATUS_FILTERS,
  VCC_STATUS_LABELS,
  VCC_STATUS_TONES,
  expiryLabel,
  isVccBrandFilter,
  isVccDirection,
  isVccSortKey,
  isVccStatusFilter,
  vccBrandParam,
  vccNarrowed,
  vccStatusParam,
  type VccBrandFilter,
  type VccSortKey,
  type VccStatusFilter,
} from './tools.ts';

/**
 * The card pool: what it holds, and how to add to it.
 *
 * The pool is drawn down by the sign-up automation rather than by anyone sitting
 * on this page, so the table is written to answer two questions at a glance —
 * how many cards are still free, and which ones are close to expiring. Both
 * filters run on the server, because a pool is expected to grow past a page and a
 * client-side filter would only ever narrow the page you happen to be looking at.
 *
 * Nothing here can reveal a card's number. The read model carries a masked form
 * and the last four digits and nothing else, so there is no control on this page
 * that could be made to show one.
 */

/** How many placeholder rows to draw while the first page is in flight. */
const SKELETON_ROWS = 8;

/** Six columns, in the order `columns` declares them. */
const SKELETON_COLUMN_WIDTHS = ['w-40', 'w-24', 'w-32', 'w-16', 'w-32', 'w-8'];

const ICON_ACTION =
  'rounded-control p-1.5 text-text-muted transition-colors duration-(--dur-micro) ease-out outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus';

function TableSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-label="Loading cards" className="@container">
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

function vccColumns({ onEdit }: { readonly onEdit: (card: VccCard) => void }): readonly DataTableColumn<VccCard>[] {
  return [
    {
      id: 'card',
      header: 'Card',
      sortKey: 'last4',
      cell: (row) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-mono text-xs text-text" title={row.maskedNumber}>
            {row.maskedNumber}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-text-subtle">
            <span className="truncate">{row.holderName}</span>
            {row.country === null ? null : <span className="shrink-0">· {row.country}</span>}
          </span>
        </span>
      ),
    },
    {
      id: 'brand',
      header: 'Brand',
      sortKey: 'brand',
      widthClassName: 'w-32',
      hideBelow: 'sm',
      cell: (row) => (
        <Badge tone="neutral" size="sm">
          {VCC_BRAND_LABELS[row.brand]}
        </Badge>
      ),
    },
    {
      id: 'status',
      header: 'State',
      sortKey: 'status',
      widthClassName: 'w-40',
      cell: (row) => (
        <span className="flex flex-col items-start gap-1">
          <Badge tone={VCC_STATUS_TONES[row.status]} size="sm">
            {VCC_STATUS_LABELS[row.status]}
          </Badge>
          <span className="truncate text-[0.6875rem] text-text-subtle" title={row.assignedTo ?? ''}>
            {row.assignedTo === null ? 'not assigned' : row.assignedTo}
          </span>
        </span>
      ),
    },
    {
      id: 'expiry',
      header: 'Expires',
      sortKey: 'expiryYear',
      align: 'end',
      widthClassName: 'w-24',
      hideBelow: 'sm',
      cell: (row) => <span className="tabular-nums text-text-muted">{expiryLabel(row)}</span>,
    },
    {
      id: 'source',
      header: 'Batch',
      hideBelow: 'lg',
      cell: (row) => (
        <span className="flex min-w-0 flex-col gap-0.5 text-[0.6875rem] text-text-subtle">
          <span className="truncate font-mono" title={row.source}>
            {row.source}
          </span>
          <span className="truncate">added {formatRelative(row.createdAt)}</span>
        </span>
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'end',
      widthClassName: 'w-8',
      cell: (row) => (
        <button
          type="button"
          className={ICON_ACTION}
          onClick={() => {
            onEdit(row);
          }}
          aria-label={`Edit ${row.maskedNumber}`}
          title="Change state"
        >
          <Pencil aria-hidden="true" className="size-3.5" />
        </button>
      ),
    },
  ];
}

export function VccPanel() {
  const [search, setSearch] = useUrlText('vcc_q');
  const [brand, setBrand] = useUrlParam<VccBrandFilter>(
    'vcc_brand',
    'all',
    VCC_BRAND_FILTERS,
  );
  const [status, setStatus] = useUrlParam<VccStatusFilter>(
    'vcc_status',
    'all',
    VCC_STATUS_FILTERS,
  );
  const [sort, setSort] = useUrlParam<VccSortKey>('vcc_sort', DEFAULT_VCC_SORT, VCC_SORT_KEYS);
  const [direction, setDirection] = useUrlParam<SortDirection>(
    'vcc_dir',
    'desc',
    VCC_DIRECTIONS,
  );

  const [editing, setEditing] = useState<VccCard | null>(null);
  const [generating, setGenerating] = useState(false);
  const [focusTarget, setFocusTarget] = useState<HTMLElement | null>(null);

  const cards = useVccCards({
    q: search,
    brand: vccBrandParam(brand),
    status: vccStatusParam(status),
    sort,
    direction,
    limit: VCC_PAGE_SIZE,
  });

  const rows = (cards.data?.pages ?? []).flatMap((page) => page.items);
  const total = cards.data?.pages[0]?.total ?? null;
  const narrowed = vccNarrowed(search, brand, status);

  const count: ListCount = cards.isPending
    ? { kind: 'loading' }
    : cards.isError
      ? { kind: 'error' }
      : { kind: 'ready', shown: rows.length, total: total ?? rows.length };

  const clearFilters = () => {
    setSearch('');
    setBrand('all');
    setStatus('all');
  };

  const handleSortChange = (next: SortState) => {
    if (next.key !== null && isVccSortKey(next.key)) setSort(next.key);
    if (isVccDirection(next.direction)) setDirection(next.direction);
  };

  const rememberFocus = () => {
    setFocusTarget(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  };

  const toolbar = (
    <ListToolbar
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search number, holder, batch or assignment…"
      filters={[
        {
          value: brand,
          options: [
            { value: 'all', label: 'Any brand' },
            ...VCC_BRANDS.map((value) => ({ value, label: VCC_BRAND_LABELS[value] })),
          ],
          onChange: (next) => {
            if (isVccBrandFilter(next)) setBrand(next);
          },
          label: 'Filter by brand',
          widthClassName: '@[480px]:w-44',
        },
        {
          value: status,
          options: [
            { value: 'all', label: 'Any state' },
            ...VCC_STATUSES.map((value) => ({ value, label: VCC_STATUS_LABELS[value] })),
          ],
          onChange: (next) => {
            if (isVccStatusFilter(next)) setStatus(next);
          },
          label: 'Filter by state',
          widthClassName: '@[480px]:w-40',
        },
      ]}
      count={count}
      noun={{ one: 'card', many: 'cards' }}
      narrowed={narrowed}
      onClear={clearFilters}
    />
  );

  const actions = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-text-muted">
        A card is minted active, held reserved while a sign-up is in flight, and finishes used or
        declined. A reserved card comes back to the pool when its sign-up is abandoned; the other
        two are final.
      </p>
      <Button
        size="sm"
        onClick={() => {
          rememberFocus();
          setGenerating(true);
        }}
      >
        <Plus aria-hidden="true" className="size-3.5" />
        Generate cards
      </Button>
    </div>
  );

  const tableColumns = vccColumns({
    onEdit: (card) => {
      rememberFocus();
      setEditing(card);
    },
  });

  if (cards.isPending) {
    return (
      <div className="flex flex-col gap-4">
        {actions}
        {toolbar}
        <TableSkeleton />
      </div>
    );
  }

  if (cards.isError) {
    return (
      <div className="flex flex-col gap-4">
        {actions}
        {toolbar}
        <Card>
          <StateView
            kind="error"
            title="Could not load the card pool"
            description="The console API did not answer. Check that the server is running, then try again."
            action={
              <Button
                variant="secondary"
                size="sm"
                loading={cards.isFetching}
                onClick={() => {
                  void cards.refetch();
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
      {actions}
      {toolbar}

      <DataTable
        rows={rows}
        columns={tableColumns}
        getRowId={(row) => row.id}
        caption="Cards in the VCC pool"
        sort={{ key: sort, direction }}
        onSortChange={handleSortChange}
        emptyState={
          <StateView
            kind={narrowed ? 'no-results' : 'empty'}
            title={narrowed ? 'No cards match' : 'The pool is empty'}
            description={
              narrowed
                ? 'Nothing in the pool matches these filters. Widen them, or clear the search.'
                : 'A sign-up that needs a card takes one from here. Generate a batch to give the next one something to use.'
            }
            icon={CreditCard}
            action={
              narrowed ? (
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => {
                    rememberFocus();
                    setGenerating(true);
                  }}
                >
                  Generate cards
                </Button>
              )
            }
          />
        }
        footer={
          cards.hasNextPage ? (
            <div className="flex justify-center py-1">
              <Button
                variant="secondary"
                size="sm"
                loading={cards.isFetchingNextPage}
                onClick={() => {
                  void cards.fetchNextPage();
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
              {formatCount(rows.length)} of {formatCount(total ?? rows.length)} cards
            </p>
          )
        }
      />

      <GenerateVccDialog
        open={generating}
        onOpenChange={setGenerating}
        restoreFocusTo={focusTarget}
      />

      <VccCardDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        card={editing}
        restoreFocusTo={focusTarget}
      />
    </div>
  );
}
