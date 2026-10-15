import { ArrowRight, Pencil, Trash2 } from 'lucide-react';
import { Fragment } from 'react';

import type { Alias, Combo, Provider } from '@contracts';

import type { DataTableColumn } from '@web/components/patterns/DataTable.tsx';
import { ProviderIcon } from '@web/components/patterns/ProviderIcon.tsx';
import { Badge } from '@web/components/ui/Badge.tsx';
import { Switch } from '@web/components/ui/Switch.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatRelative } from '@web/lib/format.ts';

import { STRATEGY_LABELS } from './combos.ts';

/**
 * The two tables on the Combos & Routes page.
 *
 * A combo and an alias are read for different reasons, so their columns differ
 * even though both are "a name and where it goes". A combo's whole content is
 * its chain, so the chain is a column and it is rendered as one — the models in
 * the order they will be tried, which is the single fact that cannot be guessed
 * from the name. An alias has no chain, so it gets the plain two-column reading:
 * the name, then the thing it points at.
 *
 * Columns drop out below a container width rather than squeezing (RULESET R3.6).
 * The enabled switch is the last to go, because it is the one control an operator
 * reaches for while scanning the list.
 */

/** How many chain entries to draw before collapsing the rest into a count. */
const MAX_CHAIN = 3;

const ICON_ACTION =
  'rounded-control p-1.5 text-text-muted transition-colors duration-(--dur-micro) ease-out outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus';

export interface RouteColumnsOptions {
  readonly providerById: ReadonlyMap<string, Provider>;
  readonly onEdit: (combo: Combo) => void;
  readonly onDelete: (combo: Combo) => void;
  readonly onToggleEnabled: (combo: Combo, enabled: boolean) => void;
}

export function comboColumns({
  providerById,
  onEdit,
  onDelete,
  onToggleEnabled,
}: RouteColumnsOptions): readonly DataTableColumn<Combo>[] {
  return [
    {
      id: 'name',
      header: 'Combo',
      sortKey: 'name',
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-medium text-text" title={row.displayName}>
            {row.displayName}
          </span>
          <span className="truncate font-mono text-[0.6875rem] text-text-subtle">{row.name}</span>
        </span>
      ),
    },
    {
      id: 'strategy',
      header: 'Strategy',
      hideBelow: 'sm',
      cell: (row) => (
        <span className="inline-flex flex-col items-start gap-1">
          <Badge tone={row.strategy === 'round_robin' ? 'info' : 'neutral'} size="sm">
            {STRATEGY_LABELS[row.strategy]}
          </Badge>
          {row.fallbackOnError ? null : (
            <span className="text-[0.6875rem] text-text-subtle">No fallback</span>
          )}
        </span>
      ),
    },
    {
      id: 'chain',
      header: 'Chain',
      hideBelow: 'md',
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          {row.entries.slice(0, MAX_CHAIN).map((entry, index) => {
            const provider =
              entry.providerId === null ? undefined : providerById.get(entry.providerId);
            return (
              <Fragment key={entry.id}>
                {index > 0 ? (
                  <ArrowRight aria-hidden="true" className="size-3 shrink-0 text-text-subtle" />
                ) : null}
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-key border border-border bg-surface-2/60 px-1.5 py-0.5 font-mono text-[0.6875rem] text-text-muted',
                    !entry.enabled && 'opacity-45',
                  )}
                  title={entry.model === '' ? 'No model set' : entry.model}
                >
                  <ProviderIcon icon={provider?.icon ?? 'box'} size="sm" muted />
                  <span className="max-w-[10rem] truncate">
                    {entry.model === '' ? '—' : entry.model}
                  </span>
                </span>
              </Fragment>
            );
          })}
          {row.entries.length > MAX_CHAIN ? (
            <span className="text-[0.6875rem] tabular-nums text-text-subtle">
              +{row.entries.length - MAX_CHAIN}
            </span>
          ) : null}
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
          aria-label={`${row.enabled ? 'Disable' : 'Enable'} ${row.displayName}`}
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
            aria-label={`Edit ${row.displayName}`}
            className={ICON_ACTION}
            onClick={() => {
              onEdit(row);
            }}
          >
            <Pencil aria-hidden="true" className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={`Delete ${row.displayName}`}
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
  ];
}

export interface AliasColumnsOptions {
  readonly providerById: ReadonlyMap<string, Provider>;
  readonly onEdit: (alias: Alias) => void;
  readonly onDelete: (alias: Alias) => void;
  readonly onToggleEnabled: (alias: Alias, enabled: boolean) => void;
}

export function aliasColumns({
  providerById,
  onEdit,
  onDelete,
  onToggleEnabled,
}: AliasColumnsOptions): readonly DataTableColumn<Alias>[] {
  return [
    {
      id: 'alias',
      header: 'Alias',
      sortKey: 'alias',
      cell: (row) => <span className="truncate font-mono text-xs text-text">{row.alias}</span>,
    },
    {
      id: 'target',
      header: 'Resolves to',
      cell: (row) => {
        const provider = row.providerId === null ? undefined : providerById.get(row.providerId);
        return (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <ArrowRight aria-hidden="true" className="size-3 shrink-0 text-text-subtle" />
            {provider === undefined ? null : <ProviderIcon icon={provider.icon} size="sm" muted />}
            <span className="truncate font-mono text-xs text-text-muted">
              {row.target === '' ? '—' : row.target}
            </span>
          </span>
        );
      },
    },
    {
      id: 'description',
      header: 'Description',
      hideBelow: 'md',
      cell: (row) => (
        <span
          className="block max-w-[24rem] truncate text-xs text-text-muted"
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
          aria-label={`${row.enabled ? 'Disable' : 'Enable'} ${row.alias}`}
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
            aria-label={`Edit ${row.alias}`}
            className={ICON_ACTION}
            onClick={() => {
              onEdit(row);
            }}
          >
            <Pencil aria-hidden="true" className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={`Delete ${row.alias}`}
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
  ];
}
