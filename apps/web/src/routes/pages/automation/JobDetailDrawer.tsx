import { Image, MonitorPlay, RefreshCw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import type { Job, JobItem, JobStep, Provider } from '@contracts';

import { JobStatusBadge } from '@web/components/patterns/JobStatusBadge.tsx';
import { Meter } from '@web/components/patterns/Meter.tsx';
import { ProviderIcon } from '@web/components/patterns/ProviderIcon.tsx';
import { StepTimeline } from '@web/components/patterns/StepTimeline.tsx';
import {
  ENGINE_LABELS,
  JOB_ACTION_LABELS,
  JOB_ACTION_VARIANTS,
  JOB_METHOD_LABELS,
  JOB_MODE_LABELS,
  JOB_STATUS_TONES,
  type JobAction,
  focusedItem,
  isLiveJob,
  jobActions,
  jobProgress,
  jobRunLabel,
} from '@web/components/patterns/job-vocabulary.ts';
import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Drawer } from '@web/components/ui/Drawer.tsx';
import { Skeleton, SkeletonText } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { buttonVariants } from '@web/components/ui/button-variants.ts';
import { useJob, useJobControl } from '@web/hooks/use-automation.ts';
import { cn } from '@web/lib/cn.ts';
import { formatCount, formatDateTime, formatDurationMs, formatRelative } from '@web/lib/format.ts';

import { BULK_PATH, JOB_PARAM } from './automation.ts';
import { jobDuration } from './logs.ts';

/**
 * One job from the history, opened.
 *
 * A finished batch is a record, and this is the whole of it: what it ran, how
 * long it took, which credential failed and why, and what each of those
 * credentials did step by step. The table answers "did anything go wrong"; the
 * drawer answers "what exactly happened", which is why the credential list is
 * selectable here and the timeline follows the selection — a job that failed on
 * one credential out of forty has one story worth reading.
 *
 * The drawer reads the job itself rather than borrowing the row, so a job that is
 * still moving stays live while it is open: the poll is attached to the job key,
 * and closing the drawer stops it. A live job also gets a link back to Bulk
 * Import, because watching a browser work and answering a challenge needs the
 * preview pane, which lives there and not here.
 */

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.6875rem] uppercase tracking-wide text-text-subtle">{label}</dt>
      <dd className="mt-0.5 truncate text-xs text-text">{children}</dd>
    </div>
  );
}

/**
 * The frame a step captured.
 *
 * The job contract names a capture by id and carries no address for it, so this
 * is drawn as the reference it is — a labelled artifact, not an image that would
 * fail to load. When the console learns to serve the bytes the tile becomes a
 * thumbnail and nothing around it has to move.
 */
function CaptureRef({ id }: { readonly id: string }) {
  return (
    <span
      className="mt-1.5 inline-flex items-center gap-1.5 rounded-control border border-border bg-surface-2 px-2 py-1"
      title="The frame this step captured, kept with the job."
    >
      <Image aria-hidden="true" className="size-3.5 text-text-subtle" />
      <span className="font-mono text-[0.6875rem] text-text-muted">{id}</span>
    </span>
  );
}

function ItemRow({
  item,
  active,
  onSelect,
}: {
  readonly item: JobItem;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <li className="border-b border-border/50 last:border-0">
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'flex w-full items-center gap-3 px-3 py-2 text-left',
          'transition duration-(--dur-micro) ease-out',
          active ? 'bg-accent/8' : 'hover:bg-surface-3',
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate font-mono text-[0.6875rem] text-text" title={item.accountLabel}>
            {item.accountLabel}
          </span>
          {item.lastError === null ? null : (
            <span className="truncate text-[0.6875rem] text-danger-text" title={item.lastError}>
              {item.lastError}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[0.6875rem] tabular-nums text-text-subtle">
          {item.attempts}/{item.maxAttempts}
        </span>
        <JobStatusBadge status={item.status} size="sm" />
      </button>
    </li>
  );
}

function JobSummary({
  job,
  provider,
}: {
  readonly job: Job;
  readonly provider: Provider | undefined;
}) {
  const duration = jobDuration(job);
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-card border border-border bg-surface-2 p-3 @[420px]:grid-cols-3">
      <Fact label="Status">
        <JobStatusBadge status={job.status} size="sm" />
      </Fact>
      <Fact label="Provider">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <ProviderIcon icon={provider?.icon ?? 'box'} size="sm" />
          <span className="truncate">{provider?.name ?? job.providerId}</span>
        </span>
      </Fact>
      <Fact label="Method">{JOB_METHOD_LABELS[job.method]}</Fact>
      <Fact label="Browser">
        {job.engine === null ? 'None' : ENGINE_LABELS[job.engine]}
        {job.mode === null ? null : ` · ${JOB_MODE_LABELS[job.mode]}`}
      </Fact>
      <Fact label="Concurrency">{`${String(job.concurrency)} at a time`}</Fact>
      <Fact label="Created">{formatDateTime(job.createdAt)}</Fact>
      <Fact label="Started">{job.startedAt === null ? '—' : formatDateTime(job.startedAt)}</Fact>
      <Fact label="Finished">{job.finishedAt === null ? '—' : formatDateTime(job.finishedAt)}</Fact>
      <Fact label="Duration">
        <span className="tabular-nums">{duration === null ? '—' : formatDurationMs(duration)}</span>
      </Fact>
      <Fact label="Credentials">
        <span className="tabular-nums">{formatCount(job.total)}</span>
      </Fact>
    </dl>
  );
}

function JobProgress({ job }: { readonly job: Job }) {
  const progress = jobProgress(job);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-xs text-text-muted">
          <span className="font-medium tabular-nums text-text">{formatCount(progress.done)}</span>{' '}
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
      <Meter
        value={progress.ratio}
        max={1}
        label="Import progress"
        tone={JOB_STATUS_TONES[job.status]}
      />
    </div>
  );
}

function StepsSection({
  item,
  stepExtra,
}: {
  readonly item: JobItem | undefined;
  readonly stepExtra: (step: JobStep) => ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-text-muted">Steps</span>
        {item === undefined ? null : (
          <span
            className="truncate font-mono text-[0.6875rem] text-text-subtle"
            title={item.accountLabel}
          >
            {item.accountLabel}
          </span>
        )}
      </div>
      <StepTimeline steps={item?.steps ?? []} stepExtra={stepExtra} />
    </section>
  );
}

export interface JobDetailDrawerProps {
  /** The job to open, or null when the drawer is closed. */
  readonly jobId: string | null;
  readonly providers: readonly Provider[];
  readonly onClose: () => void;
}

export function JobDetailDrawer({ jobId, providers, onClose }: JobDetailDrawerProps) {
  const job = useJob(jobId);
  const {
    mutate: controlJob,
    isPending: controlling,
    error: controlError,
    reset: resetControl,
  } = useJobControl(jobId ?? '');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  // A different job is a different batch: the credential picked in the last one
  // means nothing here, and a control that failed on it has nothing to say about
  // this one. `reset` is a stable reference, so this runs on the id alone.
  useEffect(() => {
    setSelectedItemId(null);
    resetControl();
  }, [jobId, resetControl]);

  const data = job.data ?? null;
  const provider = providers.find((row) => row.id === data?.providerId);
  const selected =
    data === null
      ? undefined
      : (data.items.find((item) => item.id === selectedItemId) ?? focusedItem(data));

  const actions: readonly JobAction[] = data === null ? [] : jobActions(data.status);
  const live = data !== null && isLiveJob(data.status);

  const watchHref =
    data === null ? BULK_PATH : `${BULK_PATH}?${JOB_PARAM}=${encodeURIComponent(data.id)}`;

  const footer =
    data === null || (actions.length === 0 && !live) ? undefined : (
      <>
        {live ? (
          <Link
            to={watchHref}
            className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'mr-auto')}
          >
            <MonitorPlay aria-hidden="true" className="size-3.5" />
            Watch live
          </Link>
        ) : null}
        {actions.map((action) => (
          <Button
            key={action}
            size="sm"
            variant={JOB_ACTION_VARIANTS[action]}
            loading={controlling}
            onClick={() => {
              controlJob({ action });
            }}
          >
            {JOB_ACTION_LABELS[action]}
          </Button>
        ))}
      </>
    );

  return (
    <Drawer
      open={jobId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      width="lg"
      title={data === null ? 'Job' : <span className="font-mono">{data.id}</span>}
      description={
        data === null
          ? 'One import batch and the steps it went through.'
          : `${jobRunLabel(data)} · ${String(data.concurrency)} at a time · ${provider?.name ?? data.providerId} · created ${formatRelative(data.createdAt)}`
      }
      footer={footer}
    >
      {job.isError ? (
        <StateView
          kind="error"
          title="Could not load this job"
          description="It may have been cleared, or the console API may be down."
          action={
            <Button
              variant="secondary"
              size="sm"
              loading={job.isFetching}
              onClick={() => {
                void job.refetch();
              }}
            >
              <RefreshCw aria-hidden="true" className="size-3.5" />
              Retry
            </Button>
          }
        />
      ) : data === null ? (
        <div className="space-y-4" role="status" aria-live="polite" aria-label="Loading job detail">
          <SkeletonText lines={2} />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <div className="@container flex flex-col gap-4">
          <JobSummary job={data} provider={provider} />

          <JobProgress job={data} />

          {controlError === null ? null : (
            <p role="alert" className="text-xs text-danger-text">
              {controlError.message}
            </p>
          )}

          <StepsSection
            item={selected}
            stepExtra={(step) =>
              step.screenshotId === null ? null : <CaptureRef id={step.screenshotId} />
            }
          />

          <section className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-text-muted">Batch</span>
              <span className="text-[0.6875rem] tabular-nums text-text-subtle">
                {formatCount(data.items.length)} credentials
              </span>
            </div>
            {data.items.length === 0 ? (
              <p className="text-xs text-text-subtle">This job has no credentials recorded.</p>
            ) : (
              <ul className="scrollbar-none max-h-96 overflow-y-auto rounded-control border border-border bg-surface-2">
                {data.items.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    active={item.id === selected?.id}
                    onSelect={() => {
                      setSelectedItemId(item.id);
                    }}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}
