import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  RotateCcw,
  Video,
} from 'lucide-react';
import type { ComponentType } from 'react';

import type { GenerationJob, GenerationJobStatus } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card } from '@web/components/ui/Card.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { Meter } from '@web/components/patterns/Meter.tsx';
import { TONE_GRAPHIC } from '@web/components/patterns/tone.ts';
import { useStudioGenerations } from '@web/hooks/use-tools.ts';
import { cn } from '@web/lib/cn.ts';
import { formatCount, formatRelative } from '@web/lib/format.ts';

import {
  GENERATION_STATUS_LABELS,
  GENERATION_STATUS_TONES,
  QUEUE_PAGE,
  generationProgress,
  isLiveGeneration,
  promptTitle,
} from './studio.ts';

/**
 * The queue: every render that has been asked for, and where it got to.
 *
 * A job is not an asset — one is work, the other is a result — so they are two
 * panes rather than one list with a filter. What the queue is for is the ninety
 * seconds after pressing Generate, when the question is "is it moving?" rather
 * than "what did it make"; a progress bar answers that and a thumbnail does not.
 *
 * The list polls itself while anything in it is live (`useStudioGenerations`
 * owns that), so nothing here schedules a timer.
 */

const ROW_STATUS_ICON: Record<GenerationJobStatus, ComponentType<{ className?: string }>> = {
  queued: Loader2,
  executing: Loader2,
  progress: Loader2,
  executed: CheckCircle2,
  failed: AlertTriangle,
  cancelled: Ban,
};

const SKELETON_ROWS = 6;

export interface GenerationQueueProps {
  readonly onOpenAsset: (assetId: string) => void;
  readonly onReuse: (job: GenerationJob) => void;
}

export function GenerationQueue({ onOpenAsset, onReuse }: GenerationQueueProps) {
  const generations = useStudioGenerations({
    kind: null,
    status: null,
    sort: null,
    direction: 'desc',
    limit: QUEUE_PAGE,
  });

  const rows = (generations.data?.pages ?? []).flatMap((page) => page.items);
  const total = generations.data?.pages[0]?.total ?? null;

  if (generations.isPending) {
    return (
      <div role="status" aria-live="polite" aria-label="Loading generations" className="flex flex-col gap-2">
        {Array.from({ length: SKELETON_ROWS }, (_, index) => (
          <Skeleton key={index} shape="block" className="h-16 rounded-card" />
        ))}
      </div>
    );
  }

  if (generations.isError) {
    return (
      <Card>
        <StateView
          kind="error"
          title="Could not load the queue"
          description="The generation list did not come back. Retrying may help."
          action={
            <Button
              variant="secondary"
              size="sm"
              loading={generations.isFetching}
              onClick={() => {
                void generations.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      </Card>
    );
  }

  if (rows.length === 0) {
    return (
      <Card>
        <StateView
          kind="empty"
          title="Nothing has been generated yet"
          description="Every prompt you send shows up here while it renders, then lands in the gallery."
        />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {rows.map((job) => (
          <li key={job.id}>
            <QueueRow job={job} onOpenAsset={onOpenAsset} onReuse={onReuse} />
          </li>
        ))}
      </ul>

      {generations.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            loading={generations.isFetchingNextPage}
            onClick={() => {
              void generations.fetchNextPage();
            }}
          >
            Load more
            <span className="tabular-nums text-text-muted">
              ({formatCount(rows.length)} of {formatCount(total ?? rows.length)})
            </span>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function QueueRow({
  job,
  onOpenAsset,
  onReuse,
}: {
  job: GenerationJob;
  onOpenAsset: (assetId: string) => void;
  onReuse: (job: GenerationJob) => void;
}) {
  const Icon = ROW_STATUS_ICON[job.status];
  const live = isLiveGeneration(job);
  const progress = generationProgress(job);
  const tone = GENERATION_STATUS_TONES[job.status];
  const KindIcon = job.kind === 'video' ? Video : ImageIcon;
  const title = promptTitle(job.prompt);
  const assetId = job.assetId;

  return (
    <div className="card-surface flex flex-col gap-2 p-3">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-control border border-border bg-surface-2',
            TONE_GRAPHIC[tone],
          )}
        >
          <Icon aria-hidden="true" className={cn('size-4', live && 'animate-spin-slow')} />
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text" title={job.prompt}>
            {title}
          </p>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6875rem] text-text-subtle">
            <span className="inline-flex items-center gap-1">
              <KindIcon aria-hidden="true" className="size-3" />
              {job.kind}
            </span>
            <span className="font-mono">{job.model}</span>
            <span aria-hidden="true">·</span>
            <span>{formatRelative(job.createdAt)}</span>
            {job.stage === null ? null : (
              <>
                <span aria-hidden="true">·</span>
                <span>{job.stage}</span>
              </>
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={tone} size="sm" dot={live} pulse={live}>
            {GENERATION_STATUS_LABELS[job.status]}
          </Badge>
          {job.status === 'executed' && assetId !== null ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                onOpenAsset(assetId);
              }}
            >
              View
            </Button>
          ) : null}
          {job.status === 'failed' || job.status === 'cancelled' ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                onReuse(job);
              }}
            >
              <RotateCcw aria-hidden="true" className="size-3.5" />
              Load settings
            </Button>
          ) : null}
        </div>
      </div>

      {progress === null ? null : (
        <Meter
          value={progress}
          max={1}
          role="progressbar"
          label={`${title} progress`}
          tone={tone === 'danger' ? 'danger' : 'accent'}
          size="sm"
        />
      )}

      {job.error === null ? null : (
        <p role="alert" className="text-xs text-danger-text">
          {job.error}
        </p>
      )}
    </div>
  );
}
