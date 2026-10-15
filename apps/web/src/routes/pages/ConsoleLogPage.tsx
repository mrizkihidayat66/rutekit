import { RefreshCw, Search } from 'lucide-react';
import { useState } from 'react';

import type { LogsQuery } from '@contracts';

import { LogViewer } from '@web/components/patterns/LogViewer.tsx';
import {
  RequestInspectorDrawer,
  RequestSummary,
} from '@web/components/patterns/RequestInspectorDrawer.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { SegmentedControl, type SegmentedOption } from '@web/components/ui/SegmentedControl.tsx';
import { SimpleSelect } from '@web/components/ui/Select.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { Switch } from '@web/components/ui/Switch.tsx';
import { useLogs, useRequestDetail } from '@web/hooks/use-overview.ts';
import { useUrlFlag, useUrlParam, useUrlText } from '@web/hooks/use-url-state.ts';
import { formatCount } from '@web/lib/format.ts';
import { PageHeader } from '@web/shell/PageHeader.tsx';

import {
  EMPTY_COUNTS,
  FOLLOW_MS,
  KIND_FILTERS,
  KIND_OPTIONS,
  LEVEL_FILTERS,
  LEVEL_LABELS,
  PAGE_SIZE,
  isKindFilter,
  type KindFilter,
  type LevelFilter,
} from './console-log/filters.ts';

/**
 * Console Log: everything the router says, followed like `tail -f`.
 *
 * A log is read by scanning, so this page is one dense surface rather than a set
 * of cards: the level tabs, the kind filter and the search all narrow the same
 * stream, and every one of them lives in the URL (RULESET R6.5) so a link to
 * "every warning from the account pool" reopens exactly that view.
 *
 * The level tabs carry their counts, taken from the response rather than guessed,
 * so the operator can see a level is empty before clicking it — and because the
 * counts are computed before the level filter, the tabs always add up to the
 * "All" figure even under a search.
 *
 * Follow is on by default: a log that does not move is not doing its job. It is
 * still a switch, so the operator can stop the scroll to read, and the interval
 * pauses while the tab is hidden (RULESET R6.7). Pausing reveals a manual
 * Refresh, so a stopped tail is one click from the present.
 *
 * Paging is cursor-based and appends, because the tail grows at the head: an
 * offset page would skip or repeat lines as new ones land.
 *
 * A line that names a request is selectable and opens the request inspector; a
 * line that names nothing is not, so the affordance never lies.
 */
export function ConsoleLogPage() {
  const [level, setLevel] = useUrlParam<LevelFilter>('level', 'all', LEVEL_FILTERS);
  const [kind, setKind] = useUrlParam<KindFilter>('kind', 'all', KIND_FILTERS);
  const [q, setQ] = useUrlText('q');
  const [follow, setFollow] = useUrlFlag('follow', true);
  const [selected, setSelected] = useState<{ logId: string; requestId: string } | null>(null);

  const query: Omit<LogsQuery, 'cursor'> = {
    level: level === 'all' ? null : level,
    kind: kind === 'all' ? null : kind,
    requestId: null,
    q,
    sort: 'at',
    direction: 'desc',
    limit: PAGE_SIZE,
  };

  const logs = useLogs(query, follow ? FOLLOW_MS : false);
  const detail = useRequestDetail(selected?.requestId ?? null);

  const pages = logs.data?.pages ?? [];
  const entries = pages.flatMap((page) => page.items);
  const total = pages[0]?.total ?? 0;
  const counts = pages[0]?.counts ?? EMPTY_COUNTS;
  const levelTotal = counts.debug + counts.info + counts.warn + counts.error;
  const narrowed = level !== 'all' || kind !== 'all' || q.trim() !== '';

  const levelOptions: readonly SegmentedOption<LevelFilter>[] = [
    { value: 'all', label: LEVEL_LABELS.all, trailing: <Count value={levelTotal} /> },
    { value: 'debug', label: LEVEL_LABELS.debug, trailing: <Count value={counts.debug} /> },
    { value: 'info', label: LEVEL_LABELS.info, trailing: <Count value={counts.info} /> },
    { value: 'warn', label: LEVEL_LABELS.warn, trailing: <Count value={counts.warn} /> },
    { value: 'error', label: LEVEL_LABELS.error, trailing: <Count value={counts.error} /> },
  ];

  return (
    <div className="flex min-h-full flex-col gap-5 p-5">
      <PageHeader
        title="Console Log"
        description="Every line the router emits, coloured by what it did — routing, accounts, tokens and errors. Follow the tail, or pause it to read."
        actions={
          <>
            {follow ? null : (
              <Button
                variant="secondary"
                size="sm"
                loading={logs.isFetching}
                onClick={() => {
                  void logs.refetch();
                }}
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
                Refresh
              </Button>
            )}
            <div className="flex items-center gap-2">
              <Switch
                id="follow-log"
                size="sm"
                checked={follow}
                onCheckedChange={setFollow}
                disabled={logs.isPending}
              />
              <label htmlFor="follow-log" className="cursor-pointer text-xs text-text-muted">
                Follow
              </label>
            </div>
          </>
        }
      />

      <div className="@container flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="max-w-full overflow-x-auto scrollbar-none">
            <SegmentedControl
              value={level}
              onValueChange={setLevel}
              aria-label="Filter by level"
              options={levelOptions}
            />
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <SimpleSelect
              value={kind}
              onValueChange={(next) => {
                if (isKindFilter(next)) setKind(next);
              }}
              options={KIND_OPTIONS}
              size="sm"
              className="w-36"
              aria-label="Filter by kind"
            />
            <Input
              inputSize="sm"
              type="search"
              value={q}
              onChange={(event) => {
                setQ(event.target.value);
              }}
              placeholder="Search messages, request or account"
              aria-label="Search the console log"
              leading={<Search aria-hidden="true" />}
              className="w-64"
            />
          </div>
        </div>

        {logs.isPending ? (
          <TailSkeleton />
        ) : logs.isError ? (
          <StateView
            kind="error"
            title="Could not load the console log"
            description="The console API did not answer. Check that the server is running, then try again."
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void logs.refetch();
                }}
              >
                <RefreshCw aria-hidden="true" className="size-3.5" />
                Retry
              </Button>
            }
          />
        ) : (
          <LogViewer
            entries={entries}
            activeId={selected?.logId ?? null}
            isSelectable={(entry) => entry.requestId !== null}
            onSelect={(entry) => {
              if (entry.requestId === null) return;
              setSelected({ logId: entry.id, requestId: entry.requestId });
            }}
            emptyState={
              narrowed
                ? 'No lines match the current filters. Widen the level or kind, or clear the search.'
                : 'Nothing has been logged yet. Lines appear here as the router handles traffic.'
            }
          />
        )}

        {entries.length === 0 ? null : (
          <div className="flex items-center justify-between gap-3 text-xs text-text-muted">
            <span className="tabular-nums">
              Showing {formatCount(entries.length)} of {formatCount(total)}
            </span>
            {logs.hasNextPage ? (
              <Button
                variant="secondary"
                size="sm"
                loading={logs.isFetchingNextPage}
                onClick={() => {
                  void logs.fetchNextPage();
                }}
              >
                Load more
              </Button>
            ) : null}
          </div>
        )}
      </div>

      <RequestInspectorDrawer
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        detail={detail.data ?? null}
        isLoading={detail.isLoading}
        isError={detail.isError}
      >
        {detail.data === undefined ? null : <RequestSummary request={detail.data.request} />}
      </RequestInspectorDrawer>
    </div>
  );
}

/** A count that rides inside a level tab. */
function Count({ value }: { readonly value: number }) {
  return <span className="tabular-nums text-[0.625rem] opacity-60">{formatCount(value)}</span>;
}

/** Placeholder rows shaped like the real ones, so the frame does not jump. */
function TailSkeleton() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="Loading the console log"
      className="terminal-surface flex flex-col gap-2 overflow-hidden p-3"
    >
      {Array.from({ length: 12 }, (_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton shape="text" className="w-[4.5rem] shrink-0" />
          <Skeleton shape="text" className="w-11 shrink-0" />
          <Skeleton shape="text" className="w-14 shrink-0" />
          <Skeleton shape="text" className="flex-1" />
        </div>
      ))}
    </div>
  );
}
