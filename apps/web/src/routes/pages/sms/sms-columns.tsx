import { Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { RefObject } from 'react';

import type { SmsProvider } from '@contracts';

import type { DataTableColumn } from '@web/components/patterns/DataTable.tsx';
import { Checkbox } from '@web/components/ui/Checkbox.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatCount, formatCredits, formatPercent, formatRelative } from '@web/lib/format.ts';

import { SmsStatusBadge } from './SmsStatusBadge.tsx';
import {
  SMS_PROVIDER_KIND_LABELS,
  smsProviderAttempts,
  smsProviderSuccessRatio,
} from './sms-providers.ts';

/**
 * The SMS Providers table's columns.
 *
 * Built as a function rather than declared as a constant because the first
 * column is about the selection, not about the row: the select-all box in the
 * header has to know what is currently ticked.
 *
 * The label is the row's identity, so it is the one thing that never drops out as
 * the container narrows (RULESET R3.6). What goes first is the last-used triple,
 * then the delivery tally — both are diagnostics you look up deliberately,
 * whereas the balance and the status are what you scan for.
 *
 * The row's own actions are icon buttons rather than a menu, because there are
 * only three and each is one click from a column you are already reading. Their
 * labels live in `aria-label`, so the column costs no width and still announces
 * itself (RULESET R4.2).
 */

const ICON_ACTION =
  'rounded-control p-1.5 text-text-muted transition-colors duration-(--dur-micro) ease-out outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-45';

export interface SmsColumnsOptions {
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
  /** The key whose check is in flight, so only that row's button spins. */
  readonly checkingId: string | null;
  readonly onCheck: (sms: SmsProvider) => void;
  readonly onEdit: (sms: SmsProvider) => void;
  readonly onDelete: (sms: SmsProvider) => void;
}

/** The triple the key last rented with, or a note that it has none yet. */
function tripleLabel(sms: SmsProvider): string | null {
  const parts = [sms.country, sms.operator, sms.product].filter(
    (part): part is string => part !== null && part !== '',
  );
  return parts.length === 0 ? null : parts.join(' · ');
}

export function smsColumns({
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
}: SmsColumnsOptions): readonly DataTableColumn<SmsProvider>[] {
  return [
    {
      id: 'select',
      header: (
        <Checkbox
          checked={allSelected}
          indeterminate={someSelected}
          onChange={onToggleAll}
          aria-label={allSelected ? 'Clear selection' : 'Select every key on this page'}
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
            onToggle(row.id, { range: shiftHeld.current });
          }}
          aria-label={`Select ${row.label}`}
        />
      ),
    },
    {
      id: 'key',
      header: 'Key',
      sortKey: 'label',
      cell: (row) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-xs font-medium text-text" title={row.label}>
            {row.label}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-text-subtle">
            <span className="shrink-0">{SMS_PROVIDER_KIND_LABELS[row.kind]}</span>
            {row.keyHint === null ? (
              <span>· no key</span>
            ) : (
              <span className="truncate font-mono" title="Stored write-only">
                · {row.keyHint}
              </span>
            )}
            {row.note === null ? null : <span className="truncate">· {row.note}</span>}
          </span>
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortKey: 'status',
      widthClassName: 'w-32',
      cell: (row) => (
        <span className="flex flex-col items-start gap-1">
          <SmsStatusBadge status={row.status} size="sm" />
          <span className="text-[0.6875rem] tabular-nums text-text-subtle">
            {row.lastCheckedAt === null
              ? 'never checked'
              : `checked ${formatRelative(row.lastCheckedAt)}`}
          </span>
        </span>
      ),
    },
    {
      id: 'balance',
      header: 'Balance',
      sortKey: 'balance',
      align: 'end',
      hideBelow: 'sm',
      cell: (row) => (
        <span
          className={cn(
            'tabular-nums',
            row.balance === null ? 'text-text-subtle' : 'text-text',
          )}
        >
          {row.balance === null ? '—' : formatCredits(row.balance, row.currency)}
        </span>
      ),
    },
    {
      id: 'delivery',
      header: 'Numbers rented',
      sortKey: 'successCount',
      align: 'end',
      hideBelow: 'lg',
      cell: (row) => {
        const attempts = smsProviderAttempts(row);
        if (attempts === 0) return <span className="text-text-subtle">—</span>;
        return (
          <span className="flex flex-col items-end gap-0.5">
            <span className="tabular-nums text-text-muted">{formatCount(attempts)}</span>
            <span className="text-[0.6875rem] tabular-nums text-text-subtle">
              {formatPercent(smsProviderSuccessRatio(row) * 100)} delivered
            </span>
          </span>
        );
      },
    },
    {
      id: 'triple',
      header: 'Last rented',
      hideBelow: 'lg',
      cell: (row) => {
        const label = tripleLabel(row);
        return label === null ? (
          <span className="text-text-subtle">nothing yet</span>
        ) : (
          <span className="truncate text-[0.6875rem] text-text-muted" title={label}>
            {label}
          </span>
        );
      },
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
            aria-label={`Check ${row.label}`}
            title="Check this key"
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
            aria-label={`Edit ${row.label}`}
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
            aria-label={`Delete ${row.label}`}
            title="Delete"
          >
            <Trash2 aria-hidden="true" className="size-3.5" />
          </button>
        </span>
      ),
    },
  ];
}
