import { Link } from 'react-router';

import type { Account } from '@contracts';

import { AccountQuotaCell } from '@web/components/patterns/AccountQuotaCell.tsx';
import { AccountStateBadge } from '@web/components/patterns/AccountStateBadge.tsx';
import { DataTable, type DataTableColumn } from '@web/components/patterns/DataTable.tsx';
import { cooldownSeconds } from '@web/components/patterns/account-state.ts';
import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { buttonVariants } from '@web/components/ui/button-variants.ts';
import { useClock } from '@web/hooks/useClock.ts';
import { cn } from '@web/lib/cn.ts';
import { formatCount, formatRelative, formatSpan } from '@web/lib/format.ts';

/**
 * The credential pool behind one provider.
 *
 * This is the same pool the Accounts page shows, narrowed to one provider, and
 * the two must read identically — an operator who learned the table there should
 * not have to relearn it here. So the columns are the same, and the cooldown
 * counts down locally from the server's timestamp rather than being refetched:
 * a countdown that only moves when the network answers is worse than no
 * countdown at all.
 *
 * The table is capped rather than paged. A provider rarely holds more than a
 * handful of credentials, and when it does, the full list is one link away.
 */

/** How many rows to show before deferring to the Accounts page. */
const ROW_LIMIT = 8;

export interface AccountsCardProps {
  readonly providerId: string;
  readonly accounts: readonly Account[];
  readonly className?: string;
}

export function AccountsCard({ providerId, accounts, className }: AccountsCardProps) {
  const now = useClock();
  const nowMs = now.getTime();

  const columns: readonly DataTableColumn<Account>[] = [
    {
      id: 'credential',
      header: 'Credential',
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
      id: 'state',
      header: 'State',
      cell: (row) => (
        <span className="inline-flex flex-col gap-0.5" title={row.stateReason ?? undefined}>
          <AccountStateBadge state={row.state} size="sm" />
        </span>
      ),
    },
    {
      id: 'inFlight',
      header: 'In flight',
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
      align: 'end',
      hideBelow: 'lg',
      cell: (row) => (
        <span className="text-text-muted">
          {row.lastUsedAt === null ? 'never' : formatRelative(row.lastUsedAt)}
        </span>
      ),
    },
  ];

  const shown = accounts.slice(0, ROW_LIMIT);
  const hidden = accounts.length - shown.length;

  return (
    <Card flush className={cn('flex flex-col', className)}>
      <div className="px-4 pt-4 pb-3">
        <CardHeader
          title="Accounts"
          description="Every credential the router can use for this provider, and what each one is doing."
          actions={
            <Link
              to={`/accounts?providerId=${encodeURIComponent(providerId)}`}
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            >
              All accounts
            </Link>
          }
        />
      </div>

      <div className="px-1 pb-2">
        <DataTable
          rows={shown}
          columns={columns}
          getRowId={(row) => row.id}
          caption="Accounts for this provider"
          emptyState={
            <StateView
              kind="empty"
              title="No credential attached"
              description="Import one, or sign in with OAuth if this provider supports it, and the router will start sending it traffic."
            />
          }
          footer={
            hidden > 0 ? (
              <Link
                to={`/accounts?providerId=${encodeURIComponent(providerId)}`}
                className="text-xs text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
              >
                {formatCount(hidden)} more {hidden === 1 ? 'account' : 'accounts'}
              </Link>
            ) : null
          }
        />
      </div>
    </Card>
  );
}
