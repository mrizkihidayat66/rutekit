import { Pencil } from 'lucide-react';
import type { RefObject } from 'react';
import { Link } from 'react-router';

import type { Account, Provider } from '@contracts';

import { AccountQuotaCell } from '@web/components/patterns/AccountQuotaCell.tsx';
import { AccountStateBadge } from '@web/components/patterns/AccountStateBadge.tsx';
import type { DataTableColumn } from '@web/components/patterns/DataTable.tsx';
import { ProviderIcon } from '@web/components/patterns/ProviderIcon.tsx';
import { cooldownSeconds } from '@web/components/patterns/account-state.ts';
import { Checkbox } from '@web/components/ui/Checkbox.tsx';
import { formatRelative, formatSpan } from '@web/lib/format.ts';

/**
 * The Accounts table's columns.
 *
 * Built as a function rather than declared as a constant because two of the
 * columns are about the selection, not about the row: the select-all box in the
 * header has to know what is currently ticked. Everything else is derived from
 * the row itself.
 *
 * Columns drop out below a container width rather than squeezing (RULESET
 * R3.6): provider first, then cooldown and quota, then last-used. What survives
 * at phone width is what an operator triaging a dead pool needs — which
 * credential, what state it is in, and whether it is busy.
 */

export interface AccountColumnsOptions {
  /** The clock the cooldown countdown reads, so it ticks with the page. */
  readonly nowMs: number;
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
  readonly providerById: ReadonlyMap<string, Provider>;
  readonly onEdit: (account: Account) => void;
}

export function accountColumns({
  nowMs,
  selected,
  onToggle,
  allSelected,
  someSelected,
  onToggleAll,
  shiftHeld,
  providerById,
  onEdit,
}: AccountColumnsOptions): readonly DataTableColumn<Account>[] {
  return [
    {
      id: 'select',
      header: (
        <Checkbox
          checked={allSelected}
          indeterminate={someSelected}
          onChange={onToggleAll}
          aria-label={allSelected ? 'Clear selection' : 'Select every account on this page'}
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
          aria-label={`Select ${row.label}`}
        />
      ),
    },
    {
      id: 'credential',
      header: 'Credential',
      sortKey: 'label',
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-xs text-text" title={row.label}>
            {row.label}
          </span>
          <span className="truncate font-mono text-[0.6875rem] text-text-subtle">
            {row.emailMasked ?? '—'}
          </span>
        </span>
      ),
    },
    {
      id: 'provider',
      header: 'Provider',
      hideBelow: 'sm',
      cell: (row) => {
        const provider = providerById.get(row.providerId);
        return (
          <Link
            to={`/providers/${encodeURIComponent(row.providerId)}`}
            className="inline-flex min-w-0 items-center gap-2 rounded-key outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-focus"
          >
            <ProviderIcon icon={provider?.icon ?? 'box'} size="sm" />
            <span className="truncate text-xs">{provider?.name ?? row.providerId}</span>
          </Link>
        );
      },
    },
    {
      id: 'state',
      header: 'State',
      sortKey: 'state',
      cell: (row) => (
        <span className="inline-flex flex-col gap-0.5" title={row.stateReason ?? undefined}>
          <AccountStateBadge state={row.state} size="sm" />
        </span>
      ),
    },
    {
      id: 'inFlight',
      header: 'In flight',
      sortKey: 'inFlight',
      align: 'end',
      cell: (row) => (
        <span className="tabular-nums text-text-muted">
          {row.inFlight}
          <span className="text-text-subtle">/{row.maxInFlight}</span>
        </span>
      ),
    },
    {
      id: 'cooldown',
      header: 'Cooldown',
      hideBelow: 'sm',
      cell: (row) => {
        const seconds = cooldownSeconds(row, nowMs);
        return seconds === null ? (
          <span className="text-text-subtle">—</span>
        ) : (
          <span className="tabular-nums text-warning-text">{formatSpan(seconds)}</span>
        );
      },
    },
    {
      id: 'quota',
      header: 'Quota',
      hideBelow: 'md',
      cell: (row) => <AccountQuotaCell account={row} />,
    },
    {
      id: 'lastUsed',
      header: 'Last used',
      sortKey: 'lastUsedAt',
      align: 'end',
      hideBelow: 'lg',
      cell: (row) => (
        <span className="text-text-muted">
          {row.lastUsedAt === null ? 'never' : formatRelative(row.lastUsedAt)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'end',
      widthClassName: 'w-12',
      cell: (row) => (
        <button
          type="button"
          aria-label={`Edit ${row.label}`}
          onClick={() => {
            onEdit(row);
          }}
          className="rounded-control p-1.5 text-text-muted transition-colors duration-(--dur-micro) ease-out outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
        >
          <Pencil aria-hidden="true" className="size-3.5" />
        </button>
      ),
    },
  ];
}
