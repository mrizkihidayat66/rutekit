import { Ban, Pencil, Trash2 } from 'lucide-react';

import type { ApiKey } from '@contracts';

import type { DataTableColumn } from '@web/components/patterns/DataTable.tsx';
import { Meter } from '@web/components/patterns/Meter.tsx';
import { usageTone } from '@web/components/patterns/tone.ts';
import { Badge } from '@web/components/ui/Badge.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatPercent } from '@web/lib/format.ts';

import {
  KEY_STATE_HINTS,
  KEY_STATE_LABELS,
  KEY_STATE_TONES,
  budgetRatio,
  budgetSummary,
  expiringSoon,
  expirySummary,
  keyState,
  lastUsedSummary,
  limitSummary,
  scopeSummary,
} from './keys.ts';

/**
 * The API-key table's columns.
 *
 * A key is read for two reasons, and the columns are ordered to answer both
 * without a click. Scanning the list asks "is anything wrong" — which the state
 * badge answers, and which is why it sits second, right after the name. Opening
 * one key asks "what is this allowed to do" — which is the scope, the rate
 * ceilings and the budget, in that order, because that is the order the limits
 * get reached in practice.
 *
 * The state is derived from the key rather than stored, so it cannot be stale:
 * a key that expired overnight reads as expired on the next render without
 * anything having written to it.
 */

const ICON_ACTION =
  'rounded-control p-1.5 text-text-muted transition-colors duration-(--dur-micro) ease-out outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus';

export interface KeyColumnsOptions {
  readonly onEdit: (key: ApiKey) => void;
  readonly onRevoke: (key: ApiKey) => void;
  readonly onDelete: (key: ApiKey) => void;
}

export function keyColumns({
  onEdit,
  onRevoke,
  onDelete,
}: KeyColumnsOptions): readonly DataTableColumn<ApiKey>[] {
  return [
    {
      id: 'key',
      header: 'Key',
      sortKey: 'name',
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-medium text-text" title={row.name}>
            {row.name}
          </span>
          <span className="truncate font-mono text-[0.6875rem] text-text-subtle">
            {row.prefix}…
          </span>
        </span>
      ),
    },
    {
      id: 'state',
      header: 'State',
      widthClassName: 'w-28',
      cell: (row) => {
        const state = keyState(row);
        const soon = state === 'active' && expiringSoon(row);
        return (
          <span className="inline-flex flex-col items-start gap-1">
            <Badge
              tone={KEY_STATE_TONES[state]}
              size="sm"
              dot
              pulse={state === 'active'}
              title={KEY_STATE_HINTS[state]}
            >
              {KEY_STATE_LABELS[state]}
            </Badge>
            {soon ? <span className="text-[0.6875rem] text-warning-text">Expiring soon</span> : null}
          </span>
        );
      },
    },
    {
      id: 'expires',
      header: 'Expires',
      sortKey: 'expiresAt',
      hideBelow: 'sm',
      cell: (row) => (
        <span className={cn(row.expiresAt === null ? 'text-text-subtle' : 'text-text-muted')}>
          {expirySummary(row)}
        </span>
      ),
    },
    {
      id: 'scope',
      header: 'Scope',
      hideBelow: 'md',
      cell: (row) => <span className="text-text-muted">{scopeSummary(row)}</span>,
    },
    {
      id: 'limits',
      header: 'Rate limit',
      hideBelow: 'lg',
      cell: (row) => (
        <span
          className={cn(
            row.tpsLimit === null && row.rateLimitPerMinute === null
              ? 'text-text-subtle'
              : 'text-text-muted',
          )}
        >
          {limitSummary(row)}
        </span>
      ),
    },
    {
      id: 'budget',
      header: 'Budget',
      hideBelow: 'md',
      cellClassName: 'min-w-[9rem]',
      cell: (row) => {
        const ratio = budgetRatio(row);
        if (ratio === null) {
          return <span className="text-text-subtle">No budget</span>;
        }
        return (
          <span className="flex flex-col gap-1">
            <Meter
              value={ratio}
              max={1}
              label={`Budget used by ${row.name}`}
              tone={usageTone(ratio)}
              size="sm"
            />
            <span className="text-[0.6875rem] tabular-nums text-text-muted">
              {budgetSummary(row)}
              <span className="text-text-subtle"> · {formatPercent(ratio * 100)}</span>
            </span>
          </span>
        );
      },
    },
    {
      id: 'lastUsed',
      header: 'Last used',
      sortKey: 'lastUsedAt',
      hideBelow: 'lg',
      cell: (row) => (
        <span className={cn(row.lastUsedAt === null ? 'text-text-subtle' : 'text-text-muted')}>
          {lastUsedSummary(row)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'end',
      widthClassName: 'w-28',
      cell: (row) => (
        <span className="inline-flex items-center gap-0.5">
          <button
            type="button"
            aria-label={`Edit the key ${row.name}`}
            className={ICON_ACTION}
            onClick={() => {
              onEdit(row);
            }}
          >
            <Pencil aria-hidden="true" className="size-3.5" />
          </button>
          {row.revokedAt === null ? (
            <button
              type="button"
              aria-label={`Revoke the key ${row.name}`}
              className={cn(ICON_ACTION, 'hover:text-warning')}
              onClick={() => {
                onRevoke(row);
              }}
            >
              <Ban aria-hidden="true" className="size-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            aria-label={`Delete the key ${row.name}`}
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
