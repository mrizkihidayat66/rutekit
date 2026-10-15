import { Link } from 'react-router';

import type { ProviderDetail } from '@contracts';

import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import { buttonVariants } from '@web/components/ui/button-variants.ts';
import { useClock } from '@web/hooks/useClock.ts';
import { cn } from '@web/lib/cn.ts';
import { formatCount } from '@web/lib/format.ts';

import { accountBreakdown } from './detail.ts';

/**
 * How the router picks a credential for this provider.
 *
 * This card describes rather than configures, and deliberately so: the load
 * balancing mode is a property of the pool, not of one provider, and it is set
 * once for the whole router on Combos & Routes. What *is* per-provider is the
 * live arithmetic — how many credentials are eligible right now, how many are
 * busy, and how many are out of the running and why — and that is what the card
 * actually reports, so an operator can see the strategy's effect on this provider
 * without going looking for it.
 */

export interface RoutingStrategyCardProps {
  readonly detail: ProviderDetail;
  readonly className?: string;
}

export function RoutingStrategyCard({ detail, className }: RoutingStrategyCardProps) {
  const now = useClock();
  const accounts = accountBreakdown(detail.accounts, now.getTime());

  const facts: readonly { readonly label: string; readonly value: string; readonly hint: string }[] =
    [
      {
        label: 'Eligible now',
        value: formatCount(accounts.routable),
        hint: 'Accounts the router will send a request to.',
      },
      {
        label: 'In flight',
        value: `${formatCount(accounts.inFlight)} of ${formatCount(accounts.capacity)}`,
        hint: 'Requests being served against the in-flight ceiling.',
      },
      {
        label: 'Cooling',
        value: formatCount(accounts.cooling),
        hint: 'Rate limited or exhausted, waiting out their window.',
      },
      {
        label: 'Recovering',
        value: formatCount(accounts.recovering),
        hint: 'Parked after failures, picked back up by warmup.',
      },
      {
        label: 'Parked',
        value: formatCount(accounts.parked),
        hint: 'Switched off, banned, or awaiting a first check-in.',
      },
    ];

  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader
        title="Routing strategy"
        description="How a request for this provider is matched to a credential."
        actions={
          <Link to="/combos" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            Combos &amp; Routes
          </Link>
        }
      />

      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted">
          The pool balances across every eligible credential in turn, favouring whichever has the
          fewest requests in flight, so a slow account does not collect the queue. A credential that
          fails mid-request is skipped and the next eligible one takes over; one that is cooling or
          parked is passed over entirely until it recovers. Combos and model mappings can override
          which provider a model resolves to before any of this applies.
        </p>

        <dl className="grid grid-cols-2 gap-3 @[560px]:grid-cols-3 @[900px]:grid-cols-5">
          {facts.map((fact) => (
            <div key={fact.label} className="flex flex-col gap-0.5" title={fact.hint}>
              <dt className="text-[0.6875rem] font-medium uppercase tracking-wide text-text-subtle">
                {fact.label}
              </dt>
              <dd className="text-sm tabular-nums text-text">{fact.value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Card>
  );
}
