import type { SystemHealthTile } from '@contracts';

import { TONE_CHIP } from '@web/components/patterns/tone.ts';
import { Card, CardHeader } from '@web/components/ui/Card.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { cn } from '@web/lib/cn.ts';

import { HEALTH_TONE } from './states.ts';

/**
 * The subsystems rutekit depends on, each with its state spelled out.
 *
 * The state is carried by a word *and* a colour, never colour alone — an
 * operator reading the screen over a bad connection, or with a colour-vision
 * difference, still gets the answer.
 */

export interface HealthCardProps {
  readonly tiles: readonly SystemHealthTile[];
  readonly className?: string;
}

export function HealthCard({ tiles, className }: HealthCardProps) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader title="Health" description="The subsystems rutekit runs on." />

      {tiles.length === 0 ? (
        <StateView kind="empty" title="No health data" description="The instance has not reported yet." />
      ) : (
        <ul role="list" className="flex flex-col divide-y divide-border">
          {tiles.map((tile) => (
            <li key={tile.id} className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-text">{tile.label}</p>
                <p className="mt-0.5 truncate text-[0.6875rem] text-text-subtle">
                  {tile.detail ?? 'No detail reported.'}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs tabular-nums text-text-muted">{tile.value}</span>
                <span
                  className={cn(
                    'rounded-pill border px-1.5 py-0.5 text-[0.6875rem] font-medium',
                    TONE_CHIP[HEALTH_TONE[tile.state]],
                  )}
                >
                  {tile.state}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
