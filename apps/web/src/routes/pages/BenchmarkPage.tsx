import { Play } from 'lucide-react';

import { Button } from '@web/components/ui/Button.tsx';
import { useUrlFlag, useUrlParam } from '@web/hooks/use-url-state.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import { BenchmarkRunDetail } from './benchmark/BenchmarkRunDetail.tsx';
import { BenchmarkRunList } from './benchmark/BenchmarkRunList.tsx';
import { BenchmarkTemplateEditor } from './benchmark/BenchmarkTemplateEditor.tsx';
import { COMPOSE_PARAM, RUN_PARAM } from './benchmark/benchmark.ts';

/**
 * Benchmark.
 *
 * A benchmark is a question asked of several endpoints at once, so the page is
 * two panes: the runs on the left, and whichever one is open on the right. The
 * composer takes the right pane rather than opening over the top, because a
 * template is written against the runs already on screen — the last one is
 * usually what the next one is a variation of.
 *
 * Both the open run and the composer are in the URL, so a result set is a link
 * and the back button closes the composer.
 */
export function BenchmarkPage() {
  const [runParam, setRunParam] = useUrlParam<string>(RUN_PARAM, '');
  const [composing, setComposing] = useUrlFlag(COMPOSE_PARAM, false);

  const openRun = (id: string): void => {
    setComposing(false);
    setRunParam(id);
  };

  const startComposing = (): void => {
    setRunParam('');
    setComposing(true);
  };

  return (
    <div className="@container flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="Benchmark"
        description="Send one prompt template to several endpoints and compare what comes back — how fast each started, how long each took, what each cost, and how well each scored."
        actions={
          <Button variant="secondary" size="sm" onClick={startComposing} disabled={composing}>
            <Play aria-hidden="true" className="size-3.5" />
            New run
          </Button>
        }
      />

      <div className="flex flex-col gap-4 @[1000px]:flex-row @[1000px]:items-start">
        <div className="@[1000px]:w-72 @[1000px]:shrink-0">
          <BenchmarkRunList
            selectedId={composing ? '' : runParam}
            onSelect={openRun}
            onNew={startComposing}
          />
        </div>

        <div className="min-w-0 flex-1">
          {composing ? (
            <BenchmarkTemplateEditor
              onCreated={openRun}
              onCancel={() => {
                setComposing(false);
              }}
            />
          ) : (
            <BenchmarkRunDetail runId={runParam === '' ? null : runParam} />
          )}
        </div>
      </div>
    </div>
  );
}
