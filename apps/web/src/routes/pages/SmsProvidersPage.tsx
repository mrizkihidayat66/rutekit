import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleX,
  RefreshCw,
  Send,
  Smartphone,
} from 'lucide-react';
import { useState } from 'react';

import type { SmsProvider, SmsProvidersSummary, SortDirection } from '@contracts';

import { StatTile } from '@web/components/patterns/StatTile.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { ConfirmDialog } from '@web/components/ui/Dialog.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import {
  useDeleteSmsProvider,
  useDeleteSmsProviders,
  useSmsProvidersSummary,
} from '@web/hooks/use-automation.ts';
import { useUrlParam, useUrlText } from '@web/hooks/use-url-state.ts';
import { formatCount, formatPercent } from '@web/lib/format.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { SmsFormDialog } from './sms/SmsFormDialog.tsx';
import { SmsTable } from './sms/SmsTable.tsx';
import {
  DEFAULT_SMS_PROVIDER_DIRECTION,
  DEFAULT_SMS_PROVIDER_SORT,
  KIND_FILTERS,
  SMS_PROVIDER_DIRECTIONS,
  SMS_PROVIDER_SORT_KEYS,
  STATUS_FILTERS,
  isSmsProviderDirection,
  isSmsProviderSortKey,
  type KindFilter,
  type SmsProviderSortKey,
  type StatusFilter,
} from './sms/sms-providers.ts';

/**
 * SMS Providers: the activation keys a registration job rents phone numbers
 * with.
 *
 * The page is a pool before it is a list, so it opens with the tallies — how many
 * keys are usable, how many nobody has checked, how many are held back, and how
 * many the service has refused. The last tile is the one an operator comes here
 * for: how many numbers the pool has actually delivered, which is the only figure
 * that says whether the keys work rather than whether they are configured.
 *
 * Everything narrowing the list lives in the URL (RULESET R6.5), so "the keys
 * that ran dry" is a link an operator can hand to somebody else. The dialogs do
 * not: a half-typed key is not a place worth returning to.
 */

/** Six tiles, and the summary they are built from is a single small response. */
const TILE_GRID = 'grid grid-cols-2 gap-3 @[640px]:grid-cols-3 @[960px]:grid-cols-6';

const SKELETON_TILES = 6;

/** What the delete confirmation is about: one row, or everything ticked. */
type DeleteTarget =
  | { readonly kind: 'one'; readonly sms: SmsProvider }
  | { readonly kind: 'many'; readonly ids: readonly string[]; readonly count: number };

function TileGrid({ summary }: { readonly summary: SmsProvidersSummary }) {
  const total = summary.total;
  const share = (count: number) => (total === 0 ? 0 : count / total);

  const rented = summary.successCount + summary.failCount;
  const delivered = rented === 0 ? 0 : summary.successCount / rented;

  const tiles = [
    {
      label: 'In the pool',
      value: formatCount(total),
      detail: total === 0 ? 'Nothing added yet.' : 'Every key a job may rent through.',
      icon: <Smartphone aria-hidden="true" className="size-4" />,
      tone: 'neutral' as const,
      meter: null,
    },
    {
      label: 'Active',
      value: formatCount(summary.active),
      detail: total === 0 ? '—' : `${formatPercent(share(summary.active) * 100)} of the pool`,
      icon: <CircleCheck aria-hidden="true" className="size-4" />,
      tone: 'success' as const,
      meter: share(summary.active),
    },
    {
      label: 'Untested',
      value: formatCount(summary.untested),
      detail: total === 0 ? '—' : `${formatPercent(share(summary.untested) * 100)} of the pool`,
      icon: <CircleDashed aria-hidden="true" className="size-4" />,
      tone: 'neutral' as const,
      meter: share(summary.untested),
    },
    {
      label: 'Disabled',
      value: formatCount(summary.disabled),
      detail: total === 0 ? '—' : `${formatPercent(share(summary.disabled) * 100)} of the pool`,
      icon: <Ban aria-hidden="true" className="size-4" />,
      tone: 'info' as const,
      meter: share(summary.disabled),
    },
    {
      label: 'Error',
      value: formatCount(summary.error),
      detail: total === 0 ? '—' : `${formatPercent(share(summary.error) * 100)} of the pool`,
      icon: <CircleX aria-hidden="true" className="size-4" />,
      tone: 'danger' as const,
      meter: share(summary.error),
    },
    {
      label: 'Numbers rented',
      value: formatCount(rented),
      detail:
        rented === 0
          ? 'No number has been rented yet.'
          : `${formatCount(summary.successCount)} delivered · ${formatCount(summary.failCount)} never arrived`,
      icon: <Send aria-hidden="true" className="size-4" />,
      tone: 'accent' as const,
      meter: delivered,
    },
  ];

  return (
    <ul className={TILE_GRID}>
      {tiles.map((tile) => (
        <li key={tile.label}>
          <StatTile
            label={tile.label}
            value={tile.value}
            detail={tile.detail}
            icon={tile.icon}
            tone={tile.tone}
            meter={tile.meter}
          />
        </li>
      ))}
    </ul>
  );
}

export function SmsProvidersPage() {
  const [search, setSearch] = useUrlText('q');
  const [kind, setKind] = useUrlParam<KindFilter>('kind', 'all', KIND_FILTERS);
  const [status, setStatus] = useUrlParam<StatusFilter>('status', 'all', STATUS_FILTERS);
  const [sort, setSort] = useUrlParam<SmsProviderSortKey>(
    'sort',
    DEFAULT_SMS_PROVIDER_SORT,
    SMS_PROVIDER_SORT_KEYS,
  );
  const [direction, setDirection] = useUrlParam<SortDirection>(
    'direction',
    DEFAULT_SMS_PROVIDER_DIRECTION,
    SMS_PROVIDER_DIRECTIONS,
  );

  const summary = useSmsProvidersSummary();
  const remove = useDeleteSmsProvider();
  const removeMany = useDeleteSmsProviders();

  const [editing, setEditing] = useState<SmsProvider | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [formFocus, setFormFocus] = useState<HTMLElement | null>(null);
  const [deleteReport, setDeleteReport] = useState<string | null>(null);
  /** Bumped on every removal, so the table drops ids that no longer exist. */
  const [resetToken, setResetToken] = useState(0);

  const openAdd = () => {
    setEditing(null);
    setFormFocus(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setFormOpen(true);
  };

  const openEdit = (sms: SmsProvider) => {
    setEditing(sms);
    setFormFocus(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setFormOpen(true);
  };

  const clearFilters = () => {
    setSearch('');
    setKind('all');
    setStatus('all');
  };

  const handleSortChange = (next: {
    readonly key: string | null;
    readonly direction: SortDirection;
  }) => {
    if (next.key !== null && isSmsProviderSortKey(next.key)) setSort(next.key);
    if (isSmsProviderDirection(next.direction)) setDirection(next.direction);
  };

  const confirmDelete = () => {
    if (deleteTarget === null) return;

    if (deleteTarget.kind === 'one') {
      const target = deleteTarget.sms;
      remove.mutate(target.id, {
        onSuccess: () => {
          setDeleteTarget(null);
          setDeleteReport(null);
          setResetToken((token) => token + 1);
        },
      });
      return;
    }

    removeMany.mutate(deleteTarget.ids, {
      onSuccess: (report) => {
        setDeleteTarget(null);
        setDeleteReport(
          report.failed === 0
            ? null
            : `${formatCount(report.failed)} of ${formatCount(report.requested)} could not be removed. They are still in the pool.`,
        );
        setResetToken((token) => token + 1);
      },
    });
  };

  const deleting = remove.isPending || removeMany.isPending;
  const deleteError = remove.error ?? removeMany.error;

  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="SMS Providers"
        description="The activation keys a registration job rents phone numbers with, what each one has left to spend, and how reliably its numbers arrive."
        actions={<Button onClick={openAdd}>Add a key</Button>}
      />

      <div className="@container">
        {summary.isError ? (
          <Card>
            <StateView
              kind="error"
              title="Could not read the pool"
              description="The console API did not answer, so the tallies below the header are unavailable."
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  loading={summary.isFetching}
                  onClick={() => {
                    void summary.refetch();
                  }}
                >
                  <RefreshCw aria-hidden="true" className="size-3.5" />
                  Retry
                </Button>
              }
            />
          </Card>
        ) : summary.data === undefined ? (
          <ul
            className={TILE_GRID}
            role="status"
            aria-live="polite"
            aria-label="Loading SMS pool summary"
          >
            {Array.from({ length: SKELETON_TILES }, (_, index) => (
              <li key={index}>
                <Card className="flex flex-col gap-3">
                  <Skeleton shape="text" className="w-24" />
                  <Skeleton shape="metric" className="w-16" />
                  <Skeleton shape="text" className="w-20" />
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <TileGrid summary={summary.data} />
        )}
      </div>

      {deleteReport === null ? null : (
        <p role="alert" className="text-xs text-warning-text">
          {deleteReport}
        </p>
      )}

      <SmsTable
        search={search}
        kind={kind}
        status={status}
        sort={sort}
        direction={direction}
        onSearchChange={setSearch}
        onKindChange={setKind}
        onStatusChange={setStatus}
        onClearFilters={clearFilters}
        onSortChange={handleSortChange}
        resetToken={resetToken}
        onAdd={openAdd}
        onEdit={openEdit}
        onDelete={(sms) => {
          setDeleteTarget({ kind: 'one', sms });
        }}
        onDeleteSelected={(ids) => {
          setDeleteTarget({ kind: 'many', ids, count: ids.length });
        }}
      />

      <SmsFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        sms={editing}
        restoreFocusTo={formFocus}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        destructive
        title={deleteTarget?.kind === 'many' ? 'Delete these keys?' : 'Delete this key?'}
        description={
          deleteTarget === null
            ? undefined
            : deleteTarget.kind === 'many'
              ? `${formatCount(deleteTarget.count)} ${
                  deleteTarget.count === 1 ? 'key' : 'keys'
                } will be removed from the pool. A registration job that would have rented through them has one fewer key to fall back on.`
              : `${deleteTarget.sms.label} will be removed from the pool. A registration job that would have rented through it has one fewer key to fall back on.`
        }
        confirmLabel={deleting ? 'Deleting…' : 'Delete'}
        onConfirm={confirmDelete}
      >
        {deleteError === null ? null : (
          <p role="alert" className="text-xs text-danger-text">
            {deleteError.message}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
