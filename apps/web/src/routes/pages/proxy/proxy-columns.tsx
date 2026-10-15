import { KeyRound, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { RefObject } from 'react';

import type { Proxy } from '@contracts';

import type { DataTableColumn } from '@web/components/patterns/DataTable.tsx';
import { Checkbox } from '@web/components/ui/Checkbox.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatCount, formatDurationMs, formatRelative } from '@web/lib/format.ts';

import { ProxyHealthBadge } from './ProxyHealthBadge.tsx';
import { PROXY_PROTOCOL_LABELS, proxyAddress } from './proxies.ts';

/**
 * The Proxy Pool table's columns.
 *
 * Built as a function rather than declared as a constant because the first
 * column is about the selection, not about the row: the select-all box in the
 * header has to know what is currently ticked.
 *
 * The address is the row's identity, so it is the one thing that never drops out
 * as the container narrows (RULESET R3.6). What goes first is the dispatch count,
 * then latency — both are diagnostics you look up deliberately, whereas the
 * health and whether the proxy wants credentials are what you scan for.
 *
 * The row's own actions are icon buttons rather than a menu, because there are
 * only three and each is one click from a column you are already reading. Their
 * labels live in `aria-label`, so the column costs no width and still announces
 * itself (RULESET R4.2).
 */

const ICON_ACTION =
  'rounded-control p-1.5 text-text-muted transition-colors duration-(--dur-micro) ease-out outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-45';

export interface ProxyColumnsOptions {
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (id: string, options?: { readonly range?: boolean }) => void;
  readonly allSelected: boolean;
  readonly someSelected: boolean;
  readonly onToggleAll: () => void;
  /**
   * Written on click, read on change. A checkbox's `change` event has no
   * modifier keys, so the shift state has to be caught on the click that
   * preceded it — see `useRowSelection`.
   */
  readonly shiftHeld: RefObject<boolean>;
  /** The proxy whose check is in flight, so only that row's button spins. */
  readonly checkingId: string | null;
  readonly onCheck: (proxy: Proxy) => void;
  readonly onEdit: (proxy: Proxy) => void;
  readonly onDelete: (proxy: Proxy) => void;
}

export function proxyColumns({
  selected,
  onToggle,
  allSelected,
  someSelected,
  onToggleAll,
  shiftHeld,
  checkingId,
  onCheck,
  onEdit,
  onDelete,
}: ProxyColumnsOptions): readonly DataTableColumn<Proxy>[] {
  return [
    {
      id: 'select',
      header: (
        <Checkbox
          checked={allSelected}
          indeterminate={someSelected}
          onChange={onToggleAll}
          aria-label={allSelected ? 'Clear selection' : 'Select every proxy on this page'}
        />
      ),
      widthClassName: 'w-10',
      cell: (row) => (
        <Checkbox
          checked={selected.has(row.id)}
          // The click lands first and is the only event carrying the modifier;
          // the change follows and does the work.
          onClick={(event) => {
            shiftHeld.current = event.shiftKey;
          }}
          onChange={() => {
            // Shift extends from the last row touched, the way a file list does.
            onToggle(row.id, { range: shiftHeld.current });
          }}
          aria-label={`Select ${proxyAddress(row)}`}
        />
      ),
    },
    {
      id: 'proxy',
      header: 'Proxy',
      sortKey: 'host',
      cell: (row) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-xs font-medium text-text" title={proxyAddress(row)}>
              {proxyAddress(row)}
            </span>
            {row.hasAuth ? (
              <span className="shrink-0" title="Wants a username and password">
                <KeyRound aria-hidden="true" className="size-3.5 text-text-subtle" />
              </span>
            ) : null}
          </span>
          <span className="truncate text-[0.6875rem] text-text-subtle">
            {PROXY_PROTOCOL_LABELS[row.protocol]}
            {row.note === null ? null : <span title={row.note}> · {row.note}</span>}
          </span>
        </span>
      ),
    },
    {
      id: 'health',
      header: 'Health',
      sortKey: 'health',
      widthClassName: 'w-32',
      cell: (row) => (
        <span className="flex flex-col items-start gap-1">
          <ProxyHealthBadge health={row.health} size="sm" />
          <span className="text-[0.6875rem] tabular-nums text-text-subtle">
            {row.lastCheckedAt === null ? 'never checked' : `checked ${formatRelative(row.lastCheckedAt)}`}
          </span>
        </span>
      ),
    },
    {
      id: 'latency',
      header: 'Latency',
      sortKey: 'latencyMs',
      align: 'end',
      hideBelow: 'sm',
      cell: (row) => (
        <span
          className={cn(
            'tabular-nums',
            row.latencyMs === null ? 'text-text-subtle' : 'text-text-muted',
          )}
        >
          {row.latencyMs === null ? '—' : formatDurationMs(row.latencyMs)}
        </span>
      ),
    },
    {
      id: 'dispatch',
      header: 'Dispatches',
      sortKey: 'dispatchCount',
      align: 'end',
      hideBelow: 'lg',
      cell: (row) => (
        <span className="tabular-nums text-text-muted">{formatCount(row.dispatchCount)}</span>
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'end',
      widthClassName: 'w-24',
      cell: (row) => (
        <span className="flex items-center justify-end gap-0.5">
          <button
            type="button"
            className={ICON_ACTION}
            disabled={checkingId !== null}
            onClick={() => {
              onCheck(row);
            }}
            aria-label={`Check ${proxyAddress(row)}`}
            title="Check this proxy"
          >
            <RefreshCw
              aria-hidden="true"
              className={cn('size-3.5', checkingId === row.id && 'animate-spin')}
            />
          </button>
          <button
            type="button"
            className={ICON_ACTION}
            onClick={() => {
              onEdit(row);
            }}
            aria-label={`Edit ${proxyAddress(row)}`}
            title="Edit"
          >
            <Pencil aria-hidden="true" className="size-3.5" />
          </button>
          <button
            type="button"
            className={cn(ICON_ACTION, 'hover:text-danger')}
            onClick={() => {
              onDelete(row);
            }}
            aria-label={`Delete ${proxyAddress(row)}`}
            title="Delete"
          >
            <Trash2 aria-hidden="true" className="size-3.5" />
          </button>
        </span>
      ),
    },
  ];
}
