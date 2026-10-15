import type { CreditPool } from '@contracts';

import { Meter } from '@web/components/patterns/Meter.tsx';
import { ResetCountdown } from '@web/components/patterns/ResetCountdown.tsx';
import { usageTone } from '@web/components/patterns/tone.ts';
import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatCredits, formatRatio } from '@web/lib/format.ts';

/**
 * What is left of this provider's metered credit.
 *
 * A pool is not an account quota — it belongs to the provider, and one pool
 * covers every credential behind it — so it is drawn separately rather than
 * folded into the account table. A provider with no pool at all says so plainly
 * instead of showing an empty bar, because "unmetered" and "exhausted" are the
 * two readings an operator must never confuse.
 *
 * The countdown ticks locally from the server's figure, so it keeps moving
 * between refetches; a pool with no schedule (a paid balance) shows no countdown
 * rather than a placeholder.
 */

export interface CreditPoolCardProps {
  readonly pools: readonly CreditPool[];
  readonly className?: string;
}

export function CreditPoolCard({ pools, className }: CreditPoolCardProps) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader
        title="Credit pool"
        description="Allowance the provider meters itself, shared by every credential below it."
      />

      {pools.length === 0 ? (
        <StateView
          kind="empty"
          title="Unmetered"
          description="This provider bills per request rather than from a shared allowance, so there is no pool to track."
        />
      ) : (
        <ul role="list" className="flex flex-col gap-4">
          {pools.map((pool) => {
            const ratio = pool.totalCredits > 0 ? pool.usedCredits / pool.totalCredits : 0;
            const remaining = Math.max(0, pool.totalCredits - pool.usedCredits);
            return (
              <li key={pool.label} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-xs font-medium text-text">{pool.label}</span>
                  <span className="shrink-0 text-xs tabular-nums text-text-muted">
                    {formatCredits(remaining, pool.currency)} left
                  </span>
                </div>
                <Meter
                  value={pool.usedCredits}
                  max={pool.totalCredits}
                  label={`${pool.label} usage`}
                  tone={usageTone(ratio)}
                />
                <div className="flex items-center justify-between gap-3 text-[0.6875rem] text-text-subtle">
                  <span className="tabular-nums">
                    {formatCredits(pool.usedCredits, pool.currency)} of{' '}
                    {formatCredits(pool.totalCredits, pool.currency)}
                  </span>
                  <span className="shrink-0">
                    {formatRatio(ratio)} used
                    {pool.resetInSeconds === null ? (
                      <span className="ml-2">· no reset</span>
                    ) : (
                      <span className="ml-2">
                        · resets in <ResetCountdown seconds={pool.resetInSeconds} />
                      </span>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
