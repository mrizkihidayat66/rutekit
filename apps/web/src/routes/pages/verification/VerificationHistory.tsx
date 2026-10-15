import { Plus, Search } from 'lucide-react';

import type { VerificationResult } from '@contracts';

import { Badge } from '@web/components/ui/Badge.tsx';
import { Button } from '@web/components/ui/Button.tsx';
import { Input } from '@web/components/ui/Input.tsx';
import { Skeleton } from '@web/components/ui/Skeleton.tsx';
import { StateView } from '@web/components/ui/StateView.tsx';
import { useVerifications } from '@web/hooks/use-tools.ts';
import { useUrlText } from '@web/hooks/use-url-state.ts';
import { cn } from '@web/lib/cn.ts';
import { formatRelative } from '@web/lib/format.ts';

import { SEARCH_PARAM, VERDICT_LABELS, VERDICT_TONES, endpointLabel } from './verification.ts';

/**
 * The results, newest first, and the way into a new run.
 *
 * A verification is a record of what was probed and what came back, not a
 * document anyone edits, so this list is a history. The row's heading is the
 * endpoint and the claimed family sits under it as a hypothesis, never as a
 * title — the endpoint's own name is not what was established (ADR-0017).
 */

const PAGE = 50;

function ResultRow({
  result,
  selected,
  onSelect,
}: {
  result: VerificationResult;
  selected: boolean;
  onSelect: () => void;
}) {
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
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text" title={endpointLabel(result)}>
          {endpointLabel(result)}
        </span>
        <span className="shrink-0 text-[0.6875rem] tabular-nums text-text-subtle">
          {formatRelative(result.createdAt)}
        </span>
      </span>
      <span className="flex items-center gap-2">
        <Badge tone={VERDICT_TONES[result.verdict]} size="sm">
          {VERDICT_LABELS[result.verdict]}
        </Badge>
        <span className="truncate text-[0.6875rem] text-text-subtle">
          claims {result.claimedFamily}
        </span>
      </span>
    </button>
  );
}

export interface VerificationHistoryProps {
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
  readonly onNew: () => void;
}

export function VerificationHistory({ selectedId, onSelect, onNew }: VerificationHistoryProps) {
  const [search, setSearch] = useUrlText(SEARCH_PARAM);
  const results = useVerifications({ q: search, sort: 'createdAt', direction: 'desc', limit: PAGE });

  const rows = (results.data?.pages ?? []).flatMap((page) => page.items);

  return (
    <div className="flex flex-col gap-2.5 rounded-card border border-border bg-surface-1 p-2.5">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold text-text">Verifications</h2>
        <Button variant="secondary" size="sm" onClick={onNew}>
          <Plus aria-hidden="true" className="size-3.5" />
          New
        </Button>
      </div>

      <Input
        inputSize="sm"
        type="search"
        value={search}
        placeholder="Search endpoint or family"
        aria-label="Search verifications"
        leading={<Search aria-hidden="true" />}
        onChange={(event) => {
          setSearch(event.target.value);
        }}
      />

      {results.isPending ? (
        <ul
          role="status"
          aria-live="polite"
          aria-label="Loading verifications"
          className="flex flex-col gap-1.5"
        >
          {[0, 1, 2, 3].map((index) => (
            <li key={index} className="rounded-control border border-transparent px-2.5 py-2">
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="mt-2 h-3 w-1/2" />
            </li>
          ))}
        </ul>
      ) : results.isError ? (
        <StateView
          kind="error"
          title="Verifications could not be loaded"
          description="The history did not come back. Retrying usually works."
          action={
            <Button
              variant="secondary"
              size="sm"
              loading={results.isFetching}
              onClick={() => {
                void results.refetch();
              }}
            >
              Retry
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <StateView
          kind={search === '' ? 'empty' : 'no-results'}
          title={search === '' ? 'No verifications yet' : 'Nothing matched'}
          description={
            search === ''
              ? 'Pick an endpoint, say which family it claims, and probe it.'
              : 'Try a different search, or probe a new endpoint.'
          }
        />
      ) : (
        <div className="flex flex-col gap-1">
          {rows.map((result) => (
            <ResultRow
              key={result.id}
              result={result}
              selected={result.id === selectedId}
              onSelect={() => {
                onSelect(result.id);
              }}
            />
          ))}
          {results.hasNextPage ? (
            <Button
              variant="ghost"
              size="sm"
              loading={results.isFetchingNextPage}
              onClick={() => {
                void results.fetchNextPage();
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
