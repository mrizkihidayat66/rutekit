import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import type { QuotaRow } from '@contracts';

import { Meter } from '@web/components/patterns/Meter.tsx';
import { ProviderIcon } from '@web/components/patterns/ProviderIcon.tsx';
import { ResetCountdown, ResetDeadline } from '@web/components/patterns/ResetCountdown.tsx';
import { usageTone } from '@web/components/patterns/tone.ts';
import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatCount, formatCredits, formatRatio, formatRelative } from '@web/lib/format.ts';

import { waitingOnReset, windowLabel, windowUsage } from './quota.ts';

/**
 * One provider's quota, as a card.
 *
 * The card answers three questions in order: is this provider being checked right
 * now, how much of each metered window is left, and is any of it about to refill.
 * Windows and credit pools are drawn the same way because an operator reads them
 * the same way — a bar, what is left of it, and when it comes back — even though
 * one is a request allowance and the other is money.
 *
 * A line that is nearly spent *and* scheduled to refill is marked with the sheen:
 * it is the row an operator is waiting on, and the animation says so without
 * needing a word. A paid balance that never refills gets no sheen, because
 * nothing is coming.
 */

export interface QuotaProviderCardProps {
  readonly row: QuotaRow;
  /** The provider's icon slug, looked up by the page from the catalog. */
  readonly icon: string;
  /** The provider's own sweep, or this card's check-in request, is in flight. */
  readonly busy: boolean;
  readonly onCheckIn: (providerId: string) => void;
}

interface QuotaLineProps {
  readonly label: string;
  /** Accessible name for the meter — the visible label is too terse alone. */
  readonly meterLabel: string;
  readonly used: number;
  readonly total: number;
  readonly format: (value: number) => string;
  /** What to say about the refill: a countdown, or that there is not one. */
  readonly reset: ReactNode;
  readonly sheen: boolean;
}

function QuotaLine({ label, meterLabel, used, total, format, reset, sheen }: QuotaLineProps) {
  const ratio = total > 0 ? used / total : 0;
  const remaining = Math.max(0, total - used);

  return (
    <li
      className={cn(
        'relative flex flex-col gap-1.5 overflow-hidden rounded-control px-2 py-1.5',
        sheen && 'bg-surface-2',
      )}
    >
      {sheen ? (
        <span
          aria-hidden="true"
          className="sheen pointer-events-none absolute inset-0 motion-reduce:hidden"
        />
      ) : null}

      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-xs font-medium text-text">{label}</span>
        <span className="shrink-0 text-xs tabular-nums text-text-muted">
          {format(remaining)} left
        </span>
      </div>

      <Meter value={used} max={total} label={meterLabel} tone={usageTone(ratio)} size="sm" />

      <div className="flex items-center justify-between gap-3 text-[0.6875rem] text-text-subtle">
        <span className="truncate tabular-nums">
          {format(used)} of {format(total)}
        </span>
        <span className="shrink-0">
          <span className="tabular-nums">{formatRatio(ratio)} used</span>
          <span className="ml-2">{reset}</span>
        </span>
      </div>
    </li>
  );
}

export function QuotaProviderCard({ row, icon, busy, onCheckIn }: QuotaProviderCardProps) {
  const lines = row.windows.length + row.creditPools.length;

  return (
    <Card className="flex h-full flex-col gap-3">
      <div className="flex items-start gap-3">
        <ProviderIcon icon={icon} size="sm" />

        <div className="flex min-w-0 flex-1 flex-col">
          <Link
            to={`/providers/${encodeURIComponent(row.providerId)}`}
            className="truncate rounded-key text-sm font-semibold text-text outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-focus"
          >
            {row.providerName}
          </Link>
          <span className="truncate text-[0.6875rem] text-text-subtle">
            {row.lastCheckedAt === null
              ? 'never checked'
              : `checked ${formatRelative(row.lastCheckedAt)}`}
          </span>
        </div>

        {row.checking ? (
          <Badge tone="info" size="sm" dot pulse>
            Checking
          </Badge>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            onClick={() => {
              onCheckIn(row.providerId);
            }}
          >
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Check in
          </Button>
        )}
      </div>

      {lines === 0 ? (
        <p className="flex flex-1 items-center justify-center rounded-control bg-surface-2 px-2 py-3 text-center text-xs text-text-muted">
          Nothing metered — this provider reports no allowance or balance.
        </p>
      ) : (
        <ul role="list" className="flex flex-1 flex-col gap-2">
          {row.windows.map((window) => {
            const ratio = windowUsage(window);
            return (
              <QuotaLine
                key={window.windowSeconds}
                label={windowLabel(window.windowSeconds)}
                meterLabel={`${row.providerName} ${windowLabel(window.windowSeconds)} usage`}
                used={Math.max(0, window.limit - window.remaining)}
                total={window.limit}
                format={formatCount}
                reset={
                  window.resetAt === null ? (
                    <span>· no reset</span>
                  ) : (
                    <span>
                      · resets in <ResetDeadline at={window.resetAt} />
                    </span>
                  )
                }
                sheen={waitingOnReset(ratio, window.resetAt !== null)}
              />
            );
          })}

          {row.creditPools.map((pool) => {
            const ratio = pool.totalCredits > 0 ? pool.usedCredits / pool.totalCredits : 0;
            const format = (value: number): string => formatCredits(value, pool.currency);
            return (
              <QuotaLine
                key={pool.label}
                label={pool.label}
                meterLabel={`${row.providerName} ${pool.label} usage`}
                used={pool.usedCredits}
                total={pool.totalCredits}
                format={format}
                reset={
                  pool.resetInSeconds === null ? (
                    <span>· no reset</span>
                  ) : (
                    <span>
                      · resets in <ResetCountdown seconds={pool.resetInSeconds} />
                    </span>
                  )
                }
                sheen={waitingOnReset(ratio, pool.resetInSeconds !== null)}
              />
            );
          })}
        </ul>
      )}
    </Card>
  );
}
