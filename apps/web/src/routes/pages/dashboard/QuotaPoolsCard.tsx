import type { CreditPool } from '@contracts';

import { Meter } from '@web/components/patterns/Meter.tsx';
import { ResetCountdown } from '@web/components/patterns/ResetCountdown.tsx';
import { usageTone } from '@web/components/patterns/tone.ts';
import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatCredits, formatRatio } from '@web/lib/format.ts';

/**
 * Credit pools that refill on a schedule, with a live countdown.
 *
 * The countdown ticks locally from the value the server sent, so it keeps
 * moving between refetches without the client having to poll for a number it
 * can derive. A pool with no schedule (a paid balance) shows no countdown at
 * all rather than a placeholder — "never resets" and "resets in 0s" must not
 * look the same.
 */

export interface QuotaPoolsCardProps {
  readonly pools: readonly CreditPool[];
  readonly className?: string;
}

export function QuotaPoolsCard({ pools, className }: QuotaPoolsCardProps) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader title="Quota pools" description="Credits that refill on a schedule." />

      {pools.length === 0 ? (
        <StateView
          kind="empty"
          title="No quota pools"
          description="Providers that meter usage on a schedule will show up here."
        />
      ) : (
        <ul role="list" className="flex flex-col gap-3">
          {pools.map((pool) => {
            const ratio = pool.totalCredits > 0 ? pool.usedCredits / pool.totalCredits : 0;
            const remaining = Math.max(0, pool.totalCredits - pool.usedCredits);
            return (
              <li key={pool.providerId} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-xs font-medium text-text" title={pool.providerId}>
                    {pool.label}
                  </span>
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
                  <span className="truncate font-mono">{pool.providerId}</span>
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
