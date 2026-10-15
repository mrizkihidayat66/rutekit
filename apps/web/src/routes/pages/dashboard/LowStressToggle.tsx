import { useId } from 'react';

import { Switch } from '@web/components/ui/Switch.tsx';
import { useSetLowStress } from '@web/hooks/use-overview.ts';
import { cn } from '@web/lib/cn.ts';

/**
 * The one switch that changes how the router routes.
 *
 * It lives in the page header rather than in a settings card because it is a
 * mode the operator flips while watching the dashboard — the effect of turning
 * it on shows up in the cards below. The switch stays disabled while the write
 * is in flight so a second click cannot race the first, and its state comes
 * from the dashboard query, so the switch and the tiles can never disagree.
 */

export interface LowStressToggleProps {
  readonly enabled: boolean;
  readonly className?: string;
}

export function LowStressToggle({ enabled, className }: LowStressToggleProps) {
  const id = useId();
  const mutation = useSetLowStress();

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <label htmlFor={id} className="cursor-pointer text-xs font-medium text-text-muted">
        Low-stress mode
      </label>
      <Switch
        id={id}
        size="sm"
        checked={enabled}
        disabled={mutation.isPending}
        onCheckedChange={(next) => {
          mutation.mutate(next);
        }}
      />
    </div>
  );
}
