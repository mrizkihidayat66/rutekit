import type { JobStatus } from '@contracts';

import { Badge, type BadgeSize } from '@web/components/ui/Badge.tsx';

import { JOB_STATUS_HINTS, JOB_STATUS_LABELS, JOB_STATUS_TONES, isLiveJob } from './job-vocabulary.ts';

/**
 * A job's state, as the one badge every Automation surface draws it with.
 *
 * The badge exists because the same seven words appear in a panel header, a
 * history table and a recent-jobs rail, and the two things that make the state
 * legible — the tone and whether it pulses — have to be decided the same way in
 * all three. A live state gets a pulsing dot, so a row that is going to change on
 * its own reads as moving even when the operator is not watching the poll; a
 * terminal one sits still.
 *
 * The hint rides along as the accessible description, because "Needs a hand" is
 * the right word in a table and the wrong one in isolation.
 */

export interface JobStatusBadgeProps {
  readonly status: JobStatus;
  readonly size?: BadgeSize;
}

export function JobStatusBadge({ status, size = 'md' }: JobStatusBadgeProps) {
  const live = isLiveJob(status);
  return (
    <Badge
      tone={JOB_STATUS_TONES[status]}
      size={size}
      dot
      pulse={live}
      title={JOB_STATUS_HINTS[status]}
    >
      {JOB_STATUS_LABELS[status]}
    </Badge>
  );
}
