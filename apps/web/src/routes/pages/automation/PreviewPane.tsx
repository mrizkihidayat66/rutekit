import {
  CircleCheck,
  Hourglass,
  MonitorPause,
  MonitorPlay,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react';

import type { Job, JobItem, JobStep, JobStatus } from '@contracts';

import { JOB_STATUS_LABELS } from '@web/components/patterns/job-vocabulary.ts';
import { Badge, type BadgeTone } from '@web/components/ui/Badge.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatRelative } from '@web/lib/format.ts';

/**
 * The virtual display the job's browsers are drawing into.
 *
 * A bulk import is opaque by nature — a headless browser signs in somewhere the
 * operator cannot see — so this pane is the window onto it. It shows the step
 * the focused credential is on and, when a challenge blocks the job, becomes the
 * thing the operator is actually looking at rather than a decoration beside the
 * form.
 *
 * The address is an `xvfb://` scheme rather than a real URL, because that is what
 * is being previewed: the virtual framebuffer the worker renders into, not a
 * page rutekit is serving.
 */

type PreviewState = 'queued' | 'streaming' | 'waiting' | 'paused' | 'ended';

const STATE_OF: Record<JobStatus, PreviewState> = {
  queued: 'queued',
  running: 'streaming',
  needs_manual: 'waiting',
  paused: 'paused',
  succeeded: 'ended',
  failed: 'ended',
  cancelled: 'ended',
};

const GLYPHS: Record<PreviewState, LucideIcon> = {
  queued: Hourglass,
  streaming: MonitorPlay,
  waiting: ShieldAlert,
  paused: MonitorPause,
  ended: CircleCheck,
};

const TILES: Record<PreviewState, string> = {
  queued: 'border-border bg-surface-3 text-text-muted',
  streaming: 'border-accent/30 bg-accent/10 text-accent',
  waiting: 'border-warning/30 bg-warning/12 text-warning',
  paused: 'border-border bg-surface-3 text-text-muted',
  ended: 'border-success/30 bg-success/12 text-success',
};

const BADGES: Record<PreviewState, BadgeTone> = {
  queued: 'neutral',
  streaming: 'accent',
  waiting: 'warning',
  paused: 'info',
  ended: 'neutral',
};

const BADGE_WORDS: Record<PreviewState, string> = {
  queued: 'queued',
  streaming: 'streaming',
  waiting: 'blocked',
  paused: 'paused',
  ended: 'closed',
};

function captionOf(state: PreviewState, job: Job, step: JobStep | undefined): string {
  switch (state) {
    case 'queued':
      return 'Waiting for a worker';
    case 'streaming':
      return step?.name ?? 'Launching browser';
    case 'waiting':
      return 'Waiting on a human';
    case 'paused':
      return 'Paused';
    case 'ended':
      return JOB_STATUS_LABELS[job.status];
  }
}

function detailOf(
  state: PreviewState,
  job: Job,
  item: JobItem | undefined,
  step: JobStep | undefined,
): string {
  switch (state) {
    case 'queued':
      return 'A worker picks this job up as soon as a browser slot frees.';
    case 'streaming':
      return step?.detail ?? `Working on ${item?.accountLabel ?? 'the batch'}`;
    case 'waiting':
      return step?.detail ?? 'Solve the challenge in the panel beside this preview.';
    case 'paused':
      return 'Resume the job to hand the browser back to a worker.';
    case 'ended':
      return job.finishedAt === null
        ? 'The session has closed.'
        : `Finished ${formatRelative(job.finishedAt)}.`;
  }
}

export interface PreviewPaneProps {
  readonly job: Job;
  readonly item: JobItem | undefined;
  readonly step: JobStep | undefined;
  readonly className?: string;
}

export function PreviewPane({ job, item, step, className }: PreviewPaneProps) {
  const state = STATE_OF[job.status];
  const Glyph = GLYPHS[state];

  return (
    <div className={cn('@container flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-text-muted">
          <MonitorPlay aria-hidden="true" className="size-3.5" />
          Live preview
        </span>
        <Badge tone={BADGES[state]} size="sm" dot pulse={state === 'streaming'}>
          {BADGE_WORDS[state]}
        </Badge>
      </div>

      <div className="overflow-hidden rounded-card border border-border bg-surface-2">
        <div className="flex items-center gap-2 border-b border-border bg-surface-3 px-3 py-1.5">
          <span className="flex shrink-0 gap-1" aria-hidden="true">
            <span className="size-2 rounded-pill bg-danger/50" />
            <span className="size-2 rounded-pill bg-warning/50" />
            <span className="size-2 rounded-pill bg-success/50" />
          </span>
          <span className="truncate rounded-key bg-surface-2 px-2 py-0.5 font-mono text-[0.625rem] text-text-subtle">
            xvfb://{job.providerId}
          </span>
        </div>

        <div className="relative flex aspect-video items-center justify-center overflow-hidden">
          {state === 'streaming' ? (
            <div className="sheen absolute inset-0" aria-hidden="true" />
          ) : null}
          <div className="relative flex max-w-sm flex-col items-center gap-2 px-6 text-center">
            <span
              className={cn(
                'flex size-10 items-center justify-center rounded-pill border',
                TILES[state],
              )}
            >
              <Glyph aria-hidden="true" className="size-4" />
            </span>
            <p className="text-sm font-medium text-text">{captionOf(state, job, step)}</p>
            <p className="text-xs leading-relaxed text-text-muted">
              {detailOf(state, job, item, step)}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
