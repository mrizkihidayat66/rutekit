import { Check, CircleDashed, Loader2, Minus, X, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import type { JobStep, JobStepStatus } from '@contracts';

import { cn } from '@web/lib/cn.ts';
import { formatDurationMs } from '@web/lib/format.ts';

import { JOB_STEP_STATUS_LABELS } from './job-vocabulary.ts';

/**
 * The steps one credential went through, in the order the job reports them.
 *
 * A job is a browser walking a sign-in flow, and the flow is the only thing that
 * explains a failure: "failed" on its own says nothing, while "Detect challenge →
 * failed" says the provider changed something. So the timeline leads with the
 * step names the backend emits and puts the operator-readable detail underneath
 * each one.
 *
 * The glyph carries the state rather than a badge, because a badge per row turns
 * a seven-step flow into a column of noise; the word is still there beside the
 * name, so the state is not colour-only.
 *
 * It lives here rather than beside the launcher because two surfaces read the
 * same flow: the live panel on Bulk Import, and the drawer on Automation Logs.
 * The steps are the same seven names either way, and a job that looks different
 * depending on which page you opened it from would be a bug the operator cannot
 * see the cause of.
 */

/** A glyph per state, so a finished flow reads as a checkmark down the page. */
const GLYPHS: Record<JobStepStatus, LucideIcon> = {
  pending: CircleDashed,
  running: Loader2,
  ok: Check,
  failed: X,
  skipped: Minus,
};

/** The tile around the glyph: tone-tinted for the states that matter. */
const TILES: Record<JobStepStatus, string> = {
  pending: 'border-border bg-surface-2 text-text-subtle',
  running: 'border-accent/30 bg-accent/10 text-accent',
  ok: 'border-success/30 bg-success/12 text-success',
  failed: 'border-danger/30 bg-danger/12 text-danger',
  skipped: 'border-border bg-surface-2 text-text-subtle',
};

/** A step that has not started reads as a plan, not as a result. */
const MUTED: readonly JobStepStatus[] = ['pending', 'skipped'];

function stepDuration(step: JobStep): number | null {
  if (step.startedAt === null || step.finishedAt === null) return null;
  const ms = Date.parse(step.finishedAt) - Date.parse(step.startedAt);
  return ms >= 0 ? ms : null;
}

export interface StepTimelineProps {
  readonly steps: readonly JobStep[];
  /**
   * Anything the caller wants shown under a step, inline with it. Used for the
   * screenshot a step captured, which only means something next to the step that
   * took it — a gallery of captures elsewhere in the page would lose the "when".
   */
  readonly stepExtra?: (step: JobStep) => ReactNode;
  readonly className?: string;
}

export function StepTimeline({ steps, stepExtra, className }: StepTimelineProps) {
  if (steps.length === 0) {
    return <p className={cn('text-xs text-text-subtle', className)}>No steps reported yet.</p>;
  }

  return (
    <ol className={cn('space-y-0', className)}>
      {steps.map((step, index) => {
        const Glyph = GLYPHS[step.status];
        const duration = stepDuration(step);
        const last = index === steps.length - 1;
        return (
          <li key={step.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-pill border',
                  TILES[step.status],
                )}
              >
                <Glyph
                  aria-hidden="true"
                  className={cn('size-3', step.status === 'running' && 'animate-spin-slow')}
                />
              </span>
              {last ? null : <span className="w-px flex-1 bg-border" aria-hidden="true" />}
            </div>
            <div className={cn('min-w-0', last ? 'pb-0' : 'pb-3')}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span
                  className={cn(
                    'text-xs font-medium',
                    MUTED.includes(step.status) ? 'text-text-subtle' : 'text-text',
                  )}
                >
                  {step.name}
                </span>
                <span className="text-[0.6875rem] text-text-subtle">
                  {JOB_STEP_STATUS_LABELS[step.status]}
                </span>
                {duration === null ? null : (
                  <span className="text-[0.6875rem] tabular-nums text-text-subtle">
                    {formatDurationMs(duration)}
                  </span>
                )}
              </div>
              {step.detail === null ? null : (
                <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-text-muted">
                  {step.detail}
                </p>
              )}
              {stepExtra?.(step)}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
