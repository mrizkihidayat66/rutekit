import { Plus, Search } from 'lucide-react';

import type { BenchmarkSummary } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useBenchmarks } from '@web/hooks/use-tools.ts';
import { useUrlText } from '@web/hooks/use-url-state.ts';
import { cn } from '@web/lib/cn.ts';
import { formatCount, formatRelative } from '@web/lib/format.ts';

import { RUN_STATUS_LABELS, RUN_STATUS_TONES, SEARCH_PARAM, isLiveRun } from './benchmark.ts';

/**
 * The runs, newest first, and the way into a new one.
 *
 * A run is not edited — it is a record of what was asked and what came back — so
 * this list is a history rather than a collection of documents. The only action
 * is "new", and the only other thing a row does is open.
 */

const PAGE = 50;

function RunRow({
  run,
  selected,
  onSelect,
}: {
  run: BenchmarkSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const live = isLiveRun(run.status);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full flex-col gap-1 rounded-control border px-2.5 py-2 text-left transition duration-(--dur-micro)',
        selected
          ? 'border-border bg-surface-3'
          : 'border-transparent hover:border-border hover:bg-surface-2',
      )}
    >
      <span className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{run.name}</span>
        <span className="shrink-0 text-[0.6875rem] tabular-nums text-text-subtle">
          {formatRelative(run.createdAt)}
        </span>
      </span>
      <span className="flex items-center gap-2">
        <Badge tone={RUN_STATUS_TONES[run.status]} size="sm" dot={live} pulse={live}>
          {RUN_STATUS_LABELS[run.status]}
        </Badge>
        <span className="truncate text-[0.6875rem] tabular-nums text-text-subtle">
          {formatCount(run.resultCount)} of {formatCount(run.expectedResultCount)} cells
        </span>
      </span>
    </button>
  );
}

export interface BenchmarkRunListProps {
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
  readonly onNew: () => void;
}

export function BenchmarkRunList({ selectedId, onSelect, onNew }: BenchmarkRunListProps) {
  const [search, setSearch] = useUrlText(SEARCH_PARAM);
  const runs = useBenchmarks({ q: search, sort: 'createdAt', direction: 'desc', limit: PAGE });

  const rows = (runs.data?.pages ?? []).flatMap((page) => page.items);

  return (
    <div className="flex flex-col gap-2.5 rounded-card border border-border bg-surface-1 p-2.5">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold text-text">Runs</h2>
        <Button variant="secondary" size="sm" onClick={onNew}>
          <Plus aria-hidden="true" className="size-3.5" />
          New
        </Button>
      </div>

      <Input
        inputSize="sm"
        type="search"
        value={search}
        placeholder="Search runs"
        aria-label="Search runs"
        leading={<Search aria-hidden="true" />}
        onChange={(event) => {
          setSearch(event.target.value);
        }}
      />

      {runs.isPending ? (
        <ul role="status" aria-live="polite" aria-label="Loading runs" className="flex flex-col gap-1.5">
          {[0, 1, 2, 3].map((index) => (
            <li key={index} className="rounded-control border border-transparent px-2.5 py-2">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="mt-2 h-3 w-1/2" />
            </li>
          ))}
        </ul>
      ) : runs.isError ? (
        <StateView
          kind="error"
          title="Runs could not be loaded"
          description="The run list did not come back. Retrying usually works."
          action={
            <Button
              variant="secondary"
              size="sm"
              loading={runs.isFetching}
              onClick={() => {
                void runs.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <StateView
          kind={search === '' ? 'empty' : 'no-results'}
          title={search === '' ? 'No runs yet' : 'Nothing matched'}
          description={
            search === ''
              ? 'Write a template, pick the endpoints to compare, and run it.'
              : 'Try a different search, or start a new run.'
          }
        />
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((run) => (
            <RunRow
              key={run.id}
              run={run}
              selected={run.id === selectedId}
              onSelect={() => {
                onSelect(run.id);
              }}
            />
          ))}
          {runs.hasNextPage ? (
            <Button
              variant="ghost"
              size="sm"
              loading={runs.isFetchingNextPage}
              onClick={() => {
                void runs.fetchNextPage();
              }}
            >
              Load more
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
