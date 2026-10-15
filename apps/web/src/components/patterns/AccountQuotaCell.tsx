import type { Account } from '@contracts';

import { Meter } from '@web/components/patterns/Meter.tsx';
import { usageTone } from '@web/components/patterns/tone.ts';
import { formatCount, formatCredits } from '@web/lib/format.ts';

/**
 * What one credential has left, as a table cell.
 *
 * A provider either meters requests or bills a balance, and the two read
 * differently: a metered account gets a bar with the remainder underneath, a
 * billed one gets the balance and nothing to compare it against. The Accounts
 * page and the Provider Detail page both show this column, and they must show it
 * the same way — an operator who learned the bar on one should not meet a bare
 * number on the other.
 */
export function AccountQuotaCell({ account }: { readonly account: Account }) {
  const { quota } = account;

  if (quota.limit !== null && quota.remaining !== null) {
    const used = Math.max(0, quota.limit - quota.remaining);
    const ratio = quota.limit > 0 ? used / quota.limit : 0;
    return (
      <div className="flex w-32 flex-col gap-1">
        <Meter
          value={used}
          max={quota.limit}
          label={`${account.label} quota`}
          tone={usageTone(ratio)}
          size="sm"
        />
        <span className="text-[0.6875rem] tabular-nums text-text-subtle">
          {formatCount(quota.remaining)} left
        </span>
      </div>
    );
  }

  if (quota.creditBalance !== null) {
    // A balance with no stated currency is money the provider did not label;
    // it reads as dollars rather than as a bare count of nothing.
    return (
      <span className="tabular-nums text-text-muted">
        {formatCredits(quota.creditBalance, quota.creditCurrency ?? 'USD')}
      </span>
    );
  }

  return <span className="text-text-subtle">—</span>;
}
