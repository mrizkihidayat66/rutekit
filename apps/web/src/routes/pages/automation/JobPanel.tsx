import { RefreshCw } from 'lucide-react';

import type { Job, JobItem } from '@contracts';

import { JobStatusBadge } from '@web/components/patterns/JobStatusBadge.tsx';
import { Meter } from '@web/components/patterns/Meter.tsx';
import { StepTimeline } from '@web/components/patterns/StepTimeline.tsx';
import {
  JOB_ACTION_LABELS,
  JOB_ACTION_VARIANTS,
  type JobAction,
  currentStep,
  focusedItem,
  jobActions,
  jobProgress,
  jobRunLabel,
  manualItem,
} from '@web/components/patterns/job-vocabulary.ts';
import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card, CardBody, CardHeader } from '@web/components/ui/Card.tsx';
import { cn } from '@web/lib/cn.ts';
import { formatCount, formatRelative } from '@web/lib/format.ts';

import { ManualAssistCard } from './ManualAssistCard.tsx';
import { PreviewPane } from './PreviewPane.tsx';

/**
 * One job, live.
 *
 * The panel is arranged around what the operator has to decide next. If a worker
 * is blocked on a challenge, the hand-off sits at the top and everything else is
 * context for it. Otherwise the preview and the step timeline are the story, and
 * the control bar offers only the actions that mean something in the job's
 * current state — a disabled "Resume" on a running job is noise that teaches the
 * operator to stop reading the bar.
 *
 * The item list is the batch's ledger: which credential is where, and why one
 * stopped. It is the same seven states as the badge, at the row level.
 */

function ItemRow({ item }: { readonly item: JobItem }) {
  return (
    <li className="flex items-center gap-3 border-b border-border/50 px-3 py-2 last:border-0">
      <span
        className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-text"
        title={item.accountLabel}
      >
        {item.accountLabel}
      </span>
      {item.lastError === null ? null : (
        <span
          className="hidden max-w-[16rem] truncate text-[0.6875rem] text-danger-text @[720px]:inline"
          title={item.lastError}
        >
          {item.lastError}
        </span>
      )}
      <span className="shrink-0 text-[0.6875rem] tabular-nums text-text-subtle">
        {item.attempts}/{item.maxAttempts}
      </span>
      <JobStatusBadge status={item.status} size="sm" />
    </li>
  );
}

export interface JobPanelProps {
  readonly job: Job;
  readonly controlling: boolean;
  readonly controlError: string | null;
  readonly onControl: (action: JobAction) => void;
  readonly manualSubmitting: boolean;
  readonly manualError: string | null;
  readonly onSubmitManual: (itemId: string, solution: string) => void;
}

export function JobPanel({
  job,
  controlling,
  controlError,
  onControl,
  manualSubmitting,
  manualError,
  onSubmitManual,
}: JobPanelProps) {
  const progress = jobProgress(job);
  const blocked = manualItem(job);
  const focused = focusedItem(job);
  const step = currentStep(focused);
  const actions = jobActions(job.status);

  const meta = [
    jobRunLabel(job),
    `${String(job.concurrency)} at a time`,
    job.startedAt === null ? null : `started ${formatRelative(job.startedAt)}`,
  ].filter((part): part is string => part !== null);

  return (
    <Card className="flex flex-col">
      <CardHeader
        title={<span className="font-mono">{job.id}</span>}
        description={meta.join(' · ')}
        actions={
          <>
            <JobStatusBadge status={job.status} size="sm" />
            {actions.map((action) => (
              <Button
                key={action}
                size="sm"
                variant={JOB_ACTION_VARIANTS[action]}
                loading={controlling}
                onClick={() => {
                  onControl(action);
                }}
              >
                {JOB_ACTION_LABELS[action]}
              </Button>
            ))}
          </>
        }
      />

      <CardBody className="@container flex flex-col gap-4">
        {controlError === null ? null : (
          <p role="alert" className="text-xs text-danger-text">
            {controlError}
          </p>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs text-text-muted">
              <span className="font-medium tabular-nums text-text">
                {formatCount(progress.done)}
              </span>{' '}
              of {formatCount(job.total)} credentials finished
            </span>
            <span className="flex items-center gap-2 text-[0.6875rem] tabular-nums text-text-subtle">
              <span className="text-success-text">{formatCount(job.succeeded)} ok</span>
              <span className="text-danger-text">{formatCount(job.failed)} failed</span>
              {job.needsManual > 0 ? (
                <Badge tone="warning" size="sm">
                  {formatCount(job.needsManual)} blocked
                </Badge>
              ) : null}
            </span>
          </div>
          <Meter value={progress.ratio} max={1} label="Import progress" />
        </div>

        {blocked === undefined ? null : (
          <ManualAssistCard
            job={job}
            item={blocked}
            step={currentStep(blocked)}
            submitting={manualSubmitting}
            error={manualError}
            onSubmit={onSubmitManual}
          />
        )}

        <div className="grid grid-cols-1 gap-4 @[760px]:grid-cols-2">
          <PreviewPane job={job} item={focused} step={step} />

          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-text-muted">Steps</span>
              {focused === undefined ? null : (
                <span
                  className="truncate font-mono text-[0.6875rem] text-text-subtle"
                  title={focused.accountLabel}
                >
                  {focused.accountLabel}
                </span>
              )}
            </div>
            <StepTimeline steps={focused?.steps ?? []} />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-text-muted">
            Batch
            <span className="ml-2 tabular-nums text-text-subtle">
              {formatCount(job.items.length)} credentials
            </span>
          </span>
          {job.items.length === 0 ? (
            <p className="text-xs text-text-subtle">This job has no credentials queued.</p>
          ) : (
            <ul
              className={cn(
                'scrollbar-none max-h-72 overflow-y-auto rounded-control border border-border bg-surface-2',
              )}
            >
              {job.items.map((item) => (
                <ItemRow key={item.id} item={item} />
              ))}
            </ul>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

/** Shown while a job is being read for the first time. */
export function JobPanelPending() {
  return (
    <Card>
      <CardBody className="flex items-center justify-center gap-2 py-16 text-xs text-text-muted">
        <RefreshCw aria-hidden="true" className="size-3.5 animate-spin-slow" />
        Loading the job…
      </CardBody>
    </Card>
  );
}
