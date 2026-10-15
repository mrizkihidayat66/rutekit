import type { Dashboard } from '@contracts';

import { BarList, type BarListItem } from '@web/components/patterns/BarList.tsx';
import type { Tone } from '@web/components/patterns/tone.ts';
import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatCount, formatRatio } from '@web/lib/format.ts';

/**
 * How much capacity is actually routable.
 *
 * Providers and accounts answer different halves of the same question — "is
 * there a provider that is switched on" and "does it still have an account that
 * can serve" — so both are drawn as the same breakdown rather than as two
 * unrelated stat strips. A provider can be `ready` and still have nothing
 * routable behind it, and the pair of lists is what makes that visible.
 */

export interface PoolCardProps {
  readonly providers: Dashboard['providers'];
  readonly accounts: Dashboard['accounts'];
  readonly className?: string;
}

interface Bucket {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly tone: Tone;
}

function toItems(buckets: readonly Bucket[], total: number): BarListItem[] {
  return buckets.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    value: formatCount(bucket.count),
    share: total > 0 ? bucket.count / total : 0,
    tone: bucket.tone,
    ...(total > 0 ? { hint: formatRatio(bucket.count / total) } : {}),
  }));
}

export function PoolCard({ providers, accounts, className }: PoolCardProps) {
  const providerItems = toItems(
    [
      { key: 'ready', label: 'Ready', count: providers.ready, tone: 'success' },
      { key: 'needsAuth', label: 'Needs auth', count: providers.needsAuth, tone: 'warning' },
      { key: 'error', label: 'Error', count: providers.error, tone: 'danger' },
      { key: 'disabled', label: 'Disabled', count: providers.disabled, tone: 'neutral' },
    ],
    providers.total,
  );

  const accountItems = toItems(
    [
      { key: 'active', label: 'Active', count: accounts.active, tone: 'success' },
      { key: 'inFlight', label: 'In flight', count: accounts.inFlight, tone: 'info' },
      { key: 'cooldown', label: 'Cooldown', count: accounts.cooldown, tone: 'warning' },
      { key: 'unhealthy', label: 'Unhealthy', count: accounts.unhealthy, tone: 'danger' },
    ],
    accounts.total,
  );

  return (
    <Card className={cn('@container flex flex-col', className)}>
      <CardHeader
        title="Pool"
        description={`${formatCount(providers.total)} providers, ${formatCount(accounts.total)} accounts.`}
      />

      <div className="grid grid-cols-1 gap-5 @[420px]:grid-cols-2">
        <section aria-label="Providers by status">
          <h3 className="mb-2 text-[0.6875rem] font-medium uppercase tracking-wide text-text-subtle">
            Providers
          </h3>
          <BarList items={providerItems} />
        </section>

        <section aria-label="Accounts by state">
          <h3 className="mb-2 text-[0.6875rem] font-medium uppercase tracking-wide text-text-subtle">
            Accounts
          </h3>
          <BarList items={accountItems} />
        </section>
      </div>
    </Card>
  );
}
