import { Minimize2 } from 'lucide-react';
import type { ReactNode } from 'react';

import type { TimeWindow } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import { Card, CardBody, CardHeader } from '@web/components/ui/Card.tsx';
import { SegmentedControl } from '@web/components/ui/SegmentedControl.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { AreaChart } from '@web/components/patterns/AreaChart.tsx';
import { BarList, type BarListItem } from '@web/components/patterns/BarList.tsx';
import { StatTile } from '@web/components/patterns/StatTile.tsx';
import { useTokenSaverSavings } from '@web/hooks/use-token-saver.ts';
import { useUrlParam } from '@web/hooks/use-url-state.ts';
import {
  formatBytes,
  formatCount,
  formatDateTime,
  formatDay,
  formatHour,
  formatRatio,
  formatTokens,
} from '@web/lib/format.ts';

import {
  DEFAULT_SAVINGS_WINDOW,
  isSubDay,
  NATURE_TONES,
  SAVINGS_WINDOWS,
  stageMeta,
  WINDOW_LABELS,
  WINDOW_PHRASE,
} from './savers.ts';

/**
 * What the pipeline actually removed, over a window the operator picks.
 *
 * The figures are read separately from the settings because they move on their
 * own schedule — the settings change when somebody changes them, the savings
 * change with every request the instance proxies. Splitting them also means
 * turning a stage off does not make the numbers on screen wrong for a moment:
 * the next read simply has one fewer stage in it.
 *
 * The window lives in the URL (RULESET R6.6), so "the last 30 days" is a link
 * somebody can send.
 */

export function SavingsCard() {
  const [window, setWindow] = useUrlParam<TimeWindow>(
    'window',
    DEFAULT_SAVINGS_WINDOW,
    SAVINGS_WINDOWS,
  );
  const query = useTokenSaverSavings(window);

  const windowControl = (
    <SegmentedControl
      value={window}
      onValueChange={setWindow}
      options={SAVINGS_WINDOWS.map((value) => ({ value, label: WINDOW_LABELS[value] }))}
      aria-label="Savings window"
    />
  );

  if (query.isPending) return <SavingsSkeleton control={windowControl} />;

  if (query.isError || query.data === undefined) {
    return (
      <Card>
        <CardHeader
          title="Measured savings"
          description="What the pipeline removed from outbound requests."
          actions={windowControl}
        />
        <CardBody>
          <StateView
            kind="error"
            title="Could not load the savings"
            description="The console API did not answer. Check that the server is running, then try again."
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void query.refetch();
                }}
              >
                Retry
              </Button>
            }
          />
        </CardBody>
      </Card>
    );
  }

  const savings = query.data;
  const bytesIn = savings.perStage.reduce((total, stage) => total + stage.bytesIn, 0);
  const bytesOut = savings.perStage.reduce((total, stage) => total + stage.bytesOut, 0);

  const bars: BarListItem[] = [...savings.perStage]
    .sort((a, b) => b.tokensSaved - a.tokensSaved)
    .map((stage) => {
      const meta = stageMeta(stage.stageId);
      return {
        key: stage.stageId,
        label: meta.short,
        value: formatTokens(stage.tokensSaved),
        share: savings.tokensSaved > 0 ? stage.tokensSaved / savings.tokensSaved : 0,
        tone: NATURE_TONES[meta.nature],
        hint: `${formatBytes(stage.bytesIn)} → ${formatBytes(stage.bytesOut)}`,
      };
    });

  const subDay = isSubDay(window);

  return (
    <Card>
      <CardHeader
        title="Measured savings"
        description={`What the pipeline removed over ${WINDOW_PHRASE[window]}.`}
        actions={windowControl}
      />

      <CardBody className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            label="Tokens saved"
            value={formatTokens(savings.tokensSaved)}
            tone="success"
            icon={<Minimize2 aria-hidden="true" className="size-4" />}
            detail={WINDOW_PHRASE[window]}
          />
          <StatTile
            label="Reduction"
            value={formatRatio(savings.ratio)}
            tone="accent"
            meter={savings.ratio}
            detail={`${formatTokens(savings.tokensOut)} of ${formatTokens(savings.tokensIn)} tokens out`}
          />
          <StatTile
            label="Requests processed"
            value={formatCount(savings.requestsProcessed)}
            detail={WINDOW_PHRASE[window]}
          />
          <StatTile
            label="Bytes in → out"
            value={formatBytes(bytesOut)}
            detail={`from ${formatBytes(bytesIn)}`}
          />
        </div>

        {savings.perStage.length === 0 ? (
          <StateView
            kind="empty"
            title="No stage is running"
            description="The pipeline is off, or every stage is switched off, so nothing is being compressed. Turn a stage on above to start measuring."
          />
        ) : (
          <>
            <div>
              <h3 className="text-xs font-medium text-text">Savings over time</h3>
              <AreaChart
                className="mt-3"
                labels={savings.series.map((point) =>
                  subDay ? formatHour(point.date) : formatDay(point.date),
                )}
                readoutLabels={savings.series.map((point) => formatDateTime(point.date))}
                series={[
                  {
                    key: 'saved',
                    label: 'Tokens saved',
                    tone: 'accent',
                    values: savings.series.map((point) => point.tokensSaved),
                  },
                ]}
                formatValue={formatTokens}
                ariaLabel={`Tokens saved over ${WINDOW_PHRASE[window]}`}
                heightClassName="h-48"
              />
            </div>

            <div>
              <h3 className="text-xs font-medium text-text">Where the savings came from</h3>
              <p className="mt-0.5 text-[0.6875rem] text-text-subtle">
                Each stage’s share of the tokens saved. Bars are coloured by nature — green is
                lossless, amber is lossy, blue removes nothing itself.
              </p>
              <BarList items={bars} className="mt-3" />
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function SavingsSkeleton({ control }: { readonly control: ReactNode }) {
  return (
    <Card>
      <CardHeader
        title="Measured savings"
        description="What the pipeline removed from outbound requests."
        actions={control}
      />
      <CardBody className="space-y-5">
        <div
          role="status"
          aria-live="polite"
          aria-label="Loading the savings"
          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
        >
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="card-surface flex flex-col gap-2 p-4">
              <Skeleton shape="text" className="w-24" />
              <Skeleton shape="metric" />
              <Skeleton shape="text" className="w-32" />
            </div>
          ))}
        </div>
        <Skeleton shape="block" className="h-48" />
      </CardBody>
    </Card>
  );
}
