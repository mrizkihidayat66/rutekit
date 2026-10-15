import { CircleCheck, CircleDashed, CircleX, Gauge, Network, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import type { ProxiesSummary, Proxy, SortDirection } from '@contracts';

import { StatTile } from '@web/components/patterns/StatTile.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { ConfirmDialog } from '@web/components/ui/Dialog.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useDeleteProxies, useDeleteProxy, useProxiesSummary } from '@web/hooks/use-automation.ts';
import { useUrlParam, useUrlText } from '@web/hooks/use-url-state.ts';
import { formatCount, formatPercent } from '@web/lib/format.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { ImportProxyDialog } from './proxy/ImportProxyDialog.tsx';
import { ProxyFormDialog } from './proxy/ProxyFormDialog.tsx';
import { ProxyTable } from './proxy/ProxyTable.tsx';
import {
  DEFAULT_PROXY_DIRECTION,
  DEFAULT_PROXY_SORT,
  HEALTH_FILTERS,
  PROTOCOL_FILTERS,
  PROXY_DIRECTIONS,
  PROXY_SORT_KEYS,
  isProxyDirection,
  isProxySortKey,
  proxyAddress,
  type HealthFilter,
  type ProtocolFilter,
  type ProxySortKey,
} from './proxy/proxies.ts';

/**
 * Proxy Pool: the egress addresses the router signs in through.
 *
 * The pool is a health problem before it is a list, so the page opens with the
 * tallies — how many are healthy, how many are slow enough to time out a
 * sign-in, how many are dead, and how many nobody has ever checked. The table
 * underneath is the same figures made actionable, and the sweep line above it is
 * the one thing the tiles cannot say: what the last check actually did.
 *
 * Everything narrowing the list lives in the URL (RULESET R6.5), so "the dead
 * SOCKS5 proxies" is a link an operator can hand to somebody else. The dialogs
 * do not: a half-typed proxy is not a place worth returning to.
 */

/** Five tiles, and the summary they are built from is a single small response. */
const TILE_GRID = 'grid grid-cols-2 gap-3 @[640px]:grid-cols-3 @[960px]:grid-cols-5';

const SKELETON_TILES = 5;

/** What the delete confirmation is about: one row, or everything ticked. */
type DeleteTarget =
  | { readonly kind: 'one'; readonly proxy: Proxy }
  | { readonly kind: 'many'; readonly ids: readonly string[]; readonly count: number };

function TileGrid({ summary }: { readonly summary: ProxiesSummary }) {
  const total = summary.total;
  const share = (count: number) => (total === 0 ? 0 : count / total);

  const tiles = [
    {
      label: 'In the pool',
      value: formatCount(total),
      detail: total === 0 ? 'Nothing added yet.' : 'Every proxy the router may dispatch through.',
      icon: <Network aria-hidden="true" className="size-4" />,
      tone: 'neutral' as const,
      meter: null,
    },
    {
      label: 'Healthy',
      value: formatCount(summary.healthy),
      detail: total === 0 ? '—' : `${formatPercent(share(summary.healthy) * 100)} of the pool`,
      icon: <CircleCheck aria-hidden="true" className="size-4" />,
      tone: 'success' as const,
      meter: share(summary.healthy),
    },
    {
      label: 'Slow',
      value: formatCount(summary.slow),
      detail: total === 0 ? '—' : `${formatPercent(share(summary.slow) * 100)} of the pool`,
      icon: <Gauge aria-hidden="true" className="size-4" />,
      tone: 'warning' as const,
      meter: share(summary.slow),
    },
    {
      label: 'Dead',
      value: formatCount(summary.dead),
      detail: total === 0 ? '—' : `${formatPercent(share(summary.dead) * 100)} of the pool`,
      icon: <CircleX aria-hidden="true" className="size-4" />,
      tone: 'danger' as const,
      meter: share(summary.dead),
    },
    {
      label: 'Untested',
      value: formatCount(summary.untested),
      detail: total === 0 ? '—' : `${formatPercent(share(summary.untested) * 100)} of the pool`,
      icon: <CircleDashed aria-hidden="true" className="size-4" />,
      tone: 'neutral' as const,
      meter: share(summary.untested),
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

export function ProxyPoolPage() {
  const [search, setSearch] = useUrlText('q');
  const [protocol, setProtocol] = useUrlParam<ProtocolFilter>('protocol', 'all', PROTOCOL_FILTERS);
  const [health, setHealth] = useUrlParam<HealthFilter>('health', 'all', HEALTH_FILTERS);
  const [sort, setSort] = useUrlParam<ProxySortKey>('sort', DEFAULT_PROXY_SORT, PROXY_SORT_KEYS);
  const [direction, setDirection] = useUrlParam<SortDirection>(
    'direction',
    DEFAULT_PROXY_DIRECTION,
    PROXY_DIRECTIONS,
  );

  const summary = useProxiesSummary();
  const remove = useDeleteProxy();
  const removeMany = useDeleteProxies();

  const [editing, setEditing] = useState<Proxy | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [formFocus, setFormFocus] = useState<HTMLElement | null>(null);
  const [importFocus, setImportFocus] = useState<HTMLElement | null>(null);
  const [deleteReport, setDeleteReport] = useState<string | null>(null);
  /** Bumped on every removal, so the table drops ids that no longer exist. */
  const [resetToken, setResetToken] = useState(0);

  const openAdd = () => {
    setEditing(null);
    setFormFocus(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setFormOpen(true);
  };

  const openEdit = (proxy: Proxy) => {
    setEditing(proxy);
    setFormFocus(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setFormOpen(true);
  };

  const openImport = () => {
    setImportFocus(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setImportOpen(true);
  };

  const clearFilters = () => {
    setSearch('');
    setProtocol('all');
    setHealth('all');
  };

  const handleSortChange = (next: {
    readonly key: string | null;
    readonly direction: SortDirection;
  }) => {
    if (next.key !== null && isProxySortKey(next.key)) setSort(next.key);
    if (isProxyDirection(next.direction)) setDirection(next.direction);
  };

  const confirmDelete = () => {
    if (deleteTarget === null) return;

    if (deleteTarget.kind === 'one') {
      const target = deleteTarget.proxy;
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
        title="Proxy Pool"
        description="The egress addresses rutekit signs in through, their health, and how much traffic each one has carried. A proxy nobody has checked is not a proxy that works."
        actions={
          <>
            <Button variant="secondary" onClick={openImport}>
              Import a list
            </Button>
            <Button onClick={openAdd}>Add a proxy</Button>
          </>
        }
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
          <ul className={TILE_GRID} role="status" aria-live="polite" aria-label="Loading pool summary">
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

      <ProxyTable
        search={search}
        protocol={protocol}
        health={health}
        sort={sort}
        direction={direction}
        onSearchChange={setSearch}
        onProtocolChange={setProtocol}
        onHealthChange={setHealth}
        onClearFilters={clearFilters}
        onSortChange={handleSortChange}
        resetToken={resetToken}
        onAdd={openAdd}
        onEdit={openEdit}
        onDelete={(proxy) => {
          setDeleteTarget({ kind: 'one', proxy });
        }}
        onDeleteSelected={(ids) => {
          setDeleteTarget({ kind: 'many', ids, count: ids.length });
        }}
      />

      <ProxyFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        proxy={editing}
        restoreFocusTo={formFocus}
      />

      <ImportProxyDialog open={importOpen} onOpenChange={setImportOpen} restoreFocusTo={importFocus} />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        destructive
        title={deleteTarget?.kind === 'many' ? 'Delete these proxies?' : 'Delete this proxy?'}
        description={
          deleteTarget === null
            ? undefined
            : deleteTarget.kind === 'many'
              ? `${formatCount(deleteTarget.count)} ${
                  deleteTarget.count === 1 ? 'proxy' : 'proxies'
                } will be removed from the pool. Anything currently routed through them is dispatched elsewhere.`
              : `${proxyAddress(deleteTarget.proxy)} will be removed from the pool. Anything currently routed through it is dispatched elsewhere.`
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
