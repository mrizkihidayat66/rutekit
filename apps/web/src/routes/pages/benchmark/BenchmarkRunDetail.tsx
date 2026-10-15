import { Download, FileJson } from 'lucide-react';

import type { BenchmarkRun } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Card, CardBody, CardHeader } from '@web/components/ui/Card.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { CopyButton } from '@web/components/patterns/CopyButton.tsx';
import { Meter } from '@web/components/patterns/Meter.tsx';
import { StatTile } from '@web/components/patterns/StatTile.tsx';
import { useBenchmark } from '@web/hooks/use-tools.ts';
import { downloadText } from '@web/lib/download.ts';
import {
  formatCount,
  formatDateTime,
  formatDurationMs,
  formatPercent,
  formatTps,
  formatUsd,
} from '@web/lib/format.ts';

import { BenchmarkComparison } from './BenchmarkComparison.tsx';
import { BenchmarkResults } from './BenchmarkResults.tsx';
import {
  RUN_STATUS_LABELS,
  RUN_STATUS_TONES,
  assertionLabel,
  exportFilename,
  isLiveRun,
  runProgress,
  runToCsv,
  runToJson,
  summariseRun,
  targetLabel,
} from './benchmark.ts';

/**
 * One run: what was asked, what came back, and the way out.
 *
 * The order is the order the questions get asked. What was this — the name, the
 * template and the endpoints — then how did it go — the figures — then which
 * endpoint actually won, and only then the cells themselves, because the row you
 * want is usually reachable by sorting rather than by reading.
 *
 * The export buttons sit at the top with the run rather than at the bottom of
 * the table, because a result set is the kind of thing that leaves the console:
 * it goes into a spreadsheet, a ticket or a decision, and it should not require
 * scrolling past every cell to get it out.
 */

const VARIANT_CHIPS = 8;

function TemplateBlock({ run }: { run: BenchmarkRun }) {
  return (
    <Card>
      <CardHeader
        title="Template"
        description={`${formatCount(run.variants.length)} variant${
          run.variants.length === 1 ? '' : 's'
        } across ${formatCount(run.targets.length)} endpoint${
          run.targets.length === 1 ? '' : 's'
        }`}
        actions={<CopyButton value={run.template} label="Copy template" />}
      />
      <CardBody className="flex flex-col gap-3">
        <p className="rounded-card border border-border bg-surface-2 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-text">
          {run.template}
        </p>

        {run.systemPrompt === null ? null : (
          <div className="flex flex-col gap-1">
            <span className="text-[0.6875rem] font-medium text-text-subtle">System prompt</span>
            <p className="text-xs leading-relaxed text-text-muted">{run.systemPrompt}</p>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <span className="text-[0.6875rem] font-medium text-text-subtle">Variants</span>
          <ul className="flex flex-wrap gap-1.5">
            {run.variants.slice(0, VARIANT_CHIPS).map((variant) => (
              <li key={variant.id}>
                <Badge tone="neutral" size="sm" title={variant.prompt}>
                  {variant.label}
                </Badge>
              </li>
            ))}
            {run.variants.length > VARIANT_CHIPS ? (
              <li className="self-center text-[0.6875rem] text-text-subtle">
                and {formatCount(run.variants.length - VARIANT_CHIPS)} more
              </li>
            ) : null}
          </ul>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[0.6875rem] font-medium text-text-subtle">Endpoints</span>
          <ul className="flex flex-wrap gap-1.5">
            {run.targets.map((target) => (
              <li key={`${target.providerId}::${target.model}`}>
                <Badge tone="info" size="sm">
                  <span className="font-mono">{targetLabel(target)}</span>
                </Badge>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[0.6875rem] font-medium text-text-subtle">Scoring</span>
          {run.rubric.length === 0 ? (
            // Said plainly rather than left as an empty list: a run without a
            // rubric is a legitimate choice, and the score column reading "—" is
            // the consequence of that choice rather than a gap in the data.
            <p className="text-xs text-text-muted">
              No checks, so this run measured speed and cost only.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {run.rubric.map((assertion, index) => (
                <li key={index}>
                  <Badge tone="neutral" size="sm">
                    <span className="font-mono">{assertionLabel(assertion)}</span>
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function RunBody({ run }: { run: BenchmarkRun }) {
  const summary = summariseRun(run);
  const progress = runProgress(run);
  const live = isLiveRun(run.status);

  return (
    <div className="@container flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-head text-base font-semibold tracking-tight text-text">{run.name}</h2>
            <Badge tone={RUN_STATUS_TONES[run.status]} size="sm" dot={live} pulse={live}>
              {RUN_STATUS_LABELS[run.status]}
            </Badge>
          </div>
          <p className="mt-1 text-xs tabular-nums text-text-muted">
            Started {formatDateTime(run.createdAt)}
            {run.finishedAt === null ? null : ` · finished ${formatDateTime(run.finishedAt)}`}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              downloadText(exportFilename(run, 'csv'), 'text/csv', runToCsv(run));
            }}
          >
            <Download aria-hidden="true" className="size-3.5" />
            CSV
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              downloadText(exportFilename(run, 'json'), 'application/json', runToJson(run));
            }}
          >
            <FileJson aria-hidden="true" className="size-3.5" />
            JSON
          </Button>
        </div>
      </div>

      {progress === null ? null : (
        <div className="flex flex-col gap-1.5">
          <Meter
            value={progress}
            max={1}
            role="progressbar"
            label={`${run.name} progress`}
            tone={live ? 'accent' : 'success'}
          />
          <p className="text-[0.6875rem] tabular-nums text-text-subtle">
            {formatCount(summary.cells)} of {formatCount(summary.expected)} cells reported
          </p>
        </div>
      )}

      {run.error === null ? null : (
        // The run's own failure, as opposed to a cell's: promptfoo missing, a
        // config it refused, a run that ran out of time. A failed run with no
        // explanation is the least useful shape a failure can take, so this sits
        // above the figures rather than below them.
        <p className="rounded-control border border-danger/25 bg-danger/10 px-2.5 py-2 text-xs text-danger-text">
          {run.error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 @[560px]:grid-cols-3 @[900px]:grid-cols-6">
        <StatTile
          label="Cells"
          value={formatCount(summary.cells)}
          detail={`${formatCount(summary.succeeded)} succeeded · ${formatCount(summary.failed)} failed`}
          meter={progress}
        />
        <StatTile
          label="Quality"
          value={summary.meanQuality === null ? '—' : formatPercent(summary.meanQuality * 100)}
          detail="Mean across scored cells"
          tone="success"
        />
        <StatTile
          label="First token"
          value={summary.meanTtftMs === null ? '—' : formatDurationMs(summary.meanTtftMs)}
          detail="Mean time to first token"
          tone="info"
        />
        <StatTile
          label="Total latency"
          value={summary.meanLatencyMs === null ? '—' : formatDurationMs(summary.meanLatencyMs)}
          detail="Mean whole response"
          tone="warning"
        />
        <StatTile
          label="Throughput"
          value={summary.meanTps === null ? '—' : formatTps(summary.meanTps)}
          detail="Mean output rate"
          tone="accent"
        />
        <StatTile
          label="Cost"
          value={formatUsd(summary.totalCostUsd)}
          detail={`Across ${formatCount(summary.cells)} cells`}
        />
      </div>

      <TemplateBlock run={run} />
      <BenchmarkComparison run={run} />
      <BenchmarkResults run={run} />
    </div>
  );
}

export interface BenchmarkRunDetailProps {
  readonly runId: string | null;
}

export function BenchmarkRunDetail({ runId }: BenchmarkRunDetailProps) {
  const run = useBenchmark(runId);

  if (runId === null) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-card border border-dashed border-border">
        <StateView
          kind="empty"
          title="No run selected"
          description="Open one from the list, or write a template and compare endpoints against it."
        />
      </div>
    );
  }

  if (run.isPending) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label="Loading run"
        className="flex flex-col gap-4"
      >
        <Skeleton className="h-10 w-1/2" />
        <div className="grid grid-cols-2 gap-3 @[560px]:grid-cols-3 @[900px]:grid-cols-6">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <Skeleton key={index} shape="block" className="h-24 rounded-card" />
          ))}
        </div>
        <Skeleton shape="block" className="h-56 rounded-card" />
        <Skeleton shape="block" className="h-72 rounded-card" />
      </div>
    );
  }

  if (run.isError) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-card border border-border">
        <StateView
          kind="error"
          title="That run could not be opened"
          description="It may have been removed, or the request failed. Retrying usually works."
          action={
            <Button
              variant="secondary"
              loading={run.isFetching}
              onClick={() => {
                void run.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  return <RunBody run={run.data} />;
}
