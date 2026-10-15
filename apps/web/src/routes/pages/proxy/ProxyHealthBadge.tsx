import type { ProxyHealth } from '@contracts';

import { Badge, type BadgeSize } from '@web/components/ui/Badge.tsx';

import { PROXY_HEALTH_HINTS, PROXY_HEALTH_LABELS, PROXY_HEALTH_TONES } from './proxies.ts';

/**
 * A proxy's health, as a word and a dot.
 *
 * The dot is not decoration: it is the one part of the badge that survives being
 * read at a glance across a column of forty rows, and it pulses only while the
 * state is genuinely unresolved. `untested` is the state that most needs saying
 * out loud — a proxy nobody has checked is not a proxy that works — so it is
 * drawn in the neutral tone rather than as a success.
 */
export interface ProxyHealthBadgeProps {
  readonly health: ProxyHealth;
  readonly size?: BadgeSize;
  /** Skip the explanatory title where the badge sits beside its own explanation. */
  readonly quiet?: boolean;
}

export function ProxyHealthBadge({ health, size = 'md', quiet = false }: ProxyHealthBadgeProps) {
  return (
    <Badge
      tone={PROXY_HEALTH_TONES[health]}
      size={size}
      dot
      pulse={health === 'untested'}
      title={quiet ? undefined : PROXY_HEALTH_HINTS[health]}
    >
      {PROXY_HEALTH_LABELS[health]}
    </Badge>
  );
}
