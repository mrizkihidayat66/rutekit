import { FileJson } from 'lucide-react';

import { VERDICT_BANDS, type VerificationResult, type VerificationVerdict } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { StatTile } from '@web/components/patterns/StatTile.tsx';
import { TONE_FILL, TONE_LABEL } from '@web/components/patterns/tone.ts';
import { useVerification } from '@web/hooks/use-tools.ts';
import { cn } from '@web/lib/cn.ts';
import { downloadText } from '@web/lib/download.ts';
import { formatCount, formatDateTime, formatDurationMs, formatRatio } from '@web/lib/format.ts';

import { VerificationPosterior } from './VerificationPosterior.tsx';
import { VerificationSignals } from './VerificationSignals.tsx';
import {
  VERDICT_LABELS,
  VERDICT_HINTS,
  VERDICT_TONES,
  claimedMass,
  endpointLabel,
  exportFilename,
  resultToJson,
  tallySignals,
  verdictRank,
} from './verification.ts';

/**
 * One result: the band, the evidence behind it, and the way out.
 *
 * The band is the first thing on the page and it is drawn as a scale rather than
 * a word, because the whole point of banding is that the answer is a position on
 * a range. The figures under it are the ones that decide how much weight the band
 * deserves — how much mass, how many probes, how long it took — and only then
 * comes the posterior and the individual probes that produced them.
 */

function VerdictScale({ verdict }: { verdict: VerificationVerdict }) {
  const step = verdictRank(verdict) + 1;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1" aria-hidden="true">
        {VERDICT_BANDS.map((band) => (
          <span
            key={band}
            className={cn(
              'h-1.5 flex-1 rounded-pill',
              band === verdict ? TONE_FILL[VERDICT_TONES[band]] : 'bg-surface-3',
            )}
          />
        ))}
      </div>
      <ul className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem]">
        {VERDICT_BANDS.map((band) => (
          <li
            key={band}
            aria-current={band === verdict ? 'true' : undefined}
            className={
              band === verdict
                ? cn('font-medium', TONE_LABEL[VERDICT_TONES[band]])
                : 'text-text-subtle'
            }
          >
            {VERDICT_LABELS[band]}
          </li>
        ))}
      </ul>
      <p className="text-[0.6875rem] tabular-nums text-text-subtle">
        Band {formatCount(step)} of {formatCount(VERDICT_BANDS.length)}
      </p>
    </div>
  );
}

function ResultBody({ result }: { result: VerificationResult }) {
  const tally = tallySignals(result.signals);

  return (
    <div className="@container flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-head text-base font-semibold tracking-tight text-text">
              <span className="font-mono">{endpointLabel(result)}</span>
            </h2>
            <Badge tone={VERDICT_TONES[result.verdict]} size="sm">
              {VERDICT_LABELS[result.verdict]}
            </Badge>
            <Badge tone="neutral" size="sm">
              claims {result.claimedFamily}
            </Badge>
          </div>
          <p className="mt-1 text-xs tabular-nums text-text-muted">
            Probed {formatDateTime(result.createdAt)}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              downloadText(exportFilename(result, 'json'), 'application/json', resultToJson(result));
            }}
          >
            <FileJson aria-hidden="true" className="size-3.5" />
            JSON
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-card border border-border bg-surface-1 p-4">
        <VerdictScale verdict={result.verdict} />
        <p className="text-xs leading-relaxed text-text-muted">{VERDICT_HINTS[result.verdict]}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 @[560px]:grid-cols-4">
        <StatTile
          label="Claimed mass"
          value={formatRatio(claimedMass(result))}
          detail="Posterior on the claimed family"
          tone={VERDICT_TONES[result.verdict]}
          meter={claimedMass(result)}
        />
        <StatTile
          label="Probes"
          value={formatCount(result.probesUsed)}
          detail="Requests spent on the run"
          tone="info"
        />
        <StatTile
          label="Duration"
          value={formatDurationMs(result.durationMs)}
          detail="Wall clock for the whole run"
        />
        <StatTile
          label="Signals"
          value={`${formatCount(tally.passed)}/${formatCount(tally.total)}`}
          detail={`${formatCount(tally.failed)} diverged`}
          tone={tally.failed === 0 ? 'success' : 'warning'}
        />
      </div>

      {result.notes === null ? null : (
        <p
          role="status"
          className="rounded-card border border-border bg-surface-2 p-3 text-xs leading-relaxed text-text-muted"
        >
          {result.notes}
        </p>
      )}

      <VerificationPosterior result={result} />
      <VerificationSignals signals={result.signals} />
    </div>
  );
}

export interface VerificationDetailProps {
  readonly resultId: string | null;
}

export function VerificationDetail({ resultId }: VerificationDetailProps) {
  const result = useVerification(resultId);

  if (resultId === null) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-card border border-dashed border-border">
        <StateView
          kind="empty"
          title="No verification selected"
          description="Open one from the history, or probe an endpoint and see where its behaviour lands."
        />
      </div>
    );
  }

  if (result.isPending) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label="Loading verification"
        className="flex flex-col gap-4"
      >
        <Skeleton className="h-10 w-1/2" />
        <Skeleton shape="block" className="h-28 rounded-card" />
        <div className="grid grid-cols-2 gap-3 @[560px]:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} shape="block" className="h-24 rounded-card" />
          ))}
        </div>
        <Skeleton shape="block" className="h-56 rounded-card" />
        <Skeleton shape="block" className="h-72 rounded-card" />
      </div>
    );
  }

  if (result.isError) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-card border border-border">
        <StateView
          kind="error"
          title="That verification could not be opened"
          description="It may have been removed, or the request failed. Retrying usually works."
          action={
            <Button
              variant="secondary"
              loading={result.isFetching}
              onClick={() => {
                void result.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  return <ResultBody result={result.data} />;
}
