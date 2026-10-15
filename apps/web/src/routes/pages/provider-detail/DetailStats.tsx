import { Activity, Boxes, Gauge, KeyRound } from 'lucide-react';

import type { ProviderDetail } from '@contracts';

import { StatTile } from '@web/components/patterns/StatTile.tsx';
import type { Tone } from '@web/components/patterns/tone.ts';
import { useClock } from '@web/hooks/useClock.ts';
import { cn } from '@web/lib/cn.ts';
import { formatCount } from '@web/lib/format.ts';

import { accountBreakdown, modelTally } from './detail.ts';

/**
 * The four numbers that describe this provider.
 *
 * They are chosen to answer the questions that come before any table: can it
 * serve anything (credentials), does it have capacity left (in flight), what can
 * it answer (models), and is it metered (credit). Each tile's tone is the
 * verdict, not the decoration — a provider with accounts but none routable reads
 * as a failure, and one with no credential at all reads as a warning.
 *
 * The breakdown is derived against a ticking clock, so a cooldown that lapses
 * while the page is open moves the account from "cooling" to "routable" without
 * a refetch.
 */

export interface DetailStatsProps {
  readonly detail: ProviderDetail;
  readonly className?: string;
}

export function DetailStats({ detail, className }: DetailStatsProps) {
  const now = useClock();
  const accounts = accountBreakdown(detail.accounts, now.getTime());
  const models = modelTally(detail.models);

  const credentialTone: Tone =
    accounts.total === 0 ? 'warning' : accounts.routable === 0 ? 'danger' : 'success';

  const poolCount = detail.creditPools.length;

  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-3 @[520px]:grid-cols-2 @[1100px]:grid-cols-4',
        className,
      )}
    >
      <StatTile
        label="Credentials"
        value={formatCount(accounts.routable)}
        unit={`of ${accounts.total}`}
        icon={<KeyRound aria-hidden="true" className="size-4" />}
        tone={credentialTone}
        meter={accounts.total === 0 ? null : accounts.routable / accounts.total}
        detail={
          accounts.total === 0
            ? 'Nothing attached yet.'
            : `${accounts.cooling} cooling · ${accounts.recovering} recovering · ${accounts.parked} parked`
        }
      />

      <StatTile
        label="In flight"
        value={formatCount(accounts.inFlight)}
        unit={`of ${accounts.capacity}`}
        icon={<Activity aria-hidden="true" className="size-4" />}
        tone="info"
        meter={accounts.capacity === 0 ? null : accounts.inFlight / accounts.capacity}
        detail={
          accounts.capacity === 0
            ? 'No routable capacity.'
            : `${accounts.capacity - accounts.inFlight} slots free`
        }
      />

      <StatTile
        label="Models"
        value={formatCount(models.total)}
        icon={<Boxes aria-hidden="true" className="size-4" />}
        detail={
          models.total === 0
            ? 'Nothing discovered yet.'
            : models.deprecated > 0
              ? `${models.deprecated} deprecated`
              : `${models.vision} with vision`
        }
      />

      {poolCount === 0 ? (
        <StatTile
          label="Metered credit"
          value="—"
          icon={<Gauge aria-hidden="true" className="size-4" />}
          detail="No metered credit."
        />
      ) : (
        <StatTile
          label="Metered credit"
          value={formatCount(poolCount)}
          unit={poolCount === 1 ? 'pool' : 'pools'}
          icon={<Gauge aria-hidden="true" className="size-4" />}
          tone="accent"
          detail="Refills on a schedule."
        />
      )}
    </div>
  );
}
