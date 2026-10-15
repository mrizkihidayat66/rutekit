import type { SmsProviderStatus } from '@contracts';

import { Badge, type BadgeSize } from '@web/components/ui/Badge.tsx';

import {
  SMS_PROVIDER_STATUS_HINTS,
  SMS_PROVIDER_STATUS_LABELS,
  SMS_PROVIDER_STATUS_TONES,
} from './sms-providers.ts';

/**
 * A key's state, as a word and a dot.
 *
 * The dot is not decoration: it is the one part of the badge that survives being
 * read at a glance across a column of rows, and it pulses only while the state is
 * genuinely unresolved. `untested` is the state that most needs saying out loud —
 * a key nobody has checked is not a key that can pay for a number — so it is
 * drawn in the neutral tone rather than as a success.
 */
export interface SmsStatusBadgeProps {
  readonly status: SmsProviderStatus;
  readonly size?: BadgeSize;
  /** Skip the explanatory title where the badge sits beside its own explanation. */
  readonly quiet?: boolean;
}

export function SmsStatusBadge({ status, size = 'md', quiet = false }: SmsStatusBadgeProps) {
  return (
    <Badge
      tone={SMS_PROVIDER_STATUS_TONES[status]}
      size={size}
      dot
      pulse={status === 'untested'}
      title={quiet ? undefined : SMS_PROVIDER_STATUS_HINTS[status]}
    >
      {SMS_PROVIDER_STATUS_LABELS[status]}
    </Badge>
  );
}
