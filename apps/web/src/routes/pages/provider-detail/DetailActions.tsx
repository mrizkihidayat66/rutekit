import { Activity, KeyRound, RefreshCw } from 'lucide-react';

import type { Provider } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import { useFetchProviderModels, useTestProvider } from '@web/hooks/use-providers.ts';
import { cn } from '@web/lib/cn.ts';
import { formatCount, formatDurationMs } from '@web/lib/format.ts';

/**
 * The three things an operator does to a provider from its own page.
 *
 * Both probes report back in place rather than in a toast, because what they say
 * is a fact about the provider that stays true after the moment has passed — how
 * many models it listed, how long it took to answer — and an operator comparing
 * two providers wants both numbers on screen at once.
 *
 * Neither probe is optimistic: a probe is a question, and the answer is the whole
 * point, so the button waits for it. The result line is a live region, and a
 * failure is an alert, so the outcome is announced rather than only coloured.
 */

export interface DetailActionsProps {
  readonly provider: Provider;
  readonly onImport: () => void;
  readonly className?: string;
}

export function DetailActions({ provider, onImport, className }: DetailActionsProps) {
  const test = useTestProvider(provider.id);
  const fetchModels = useFetchProviderModels(provider.id);

  return (
    <div className={cn('flex flex-col items-end gap-1.5', className)}>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={test.isPending}
          onClick={() => {
            test.mutate();
          }}
        >
          <Activity aria-hidden="true" className="size-3.5" />
          Test
        </Button>

        <Button
          variant="secondary"
          size="sm"
          loading={fetchModels.isPending}
          onClick={() => {
            fetchModels.mutate();
          }}
        >
          <RefreshCw aria-hidden="true" className="size-3.5" />
          Fetch models
        </Button>

        <Button size="sm" onClick={onImport}>
          <KeyRound aria-hidden="true" className="size-3.5" />
          Import credential
        </Button>
      </div>

      {test.isSuccess ? (
        <p role="status" aria-live="polite" className="text-[0.6875rem] tabular-nums text-text-muted">
          {test.data.ok
            ? `Answered in ${formatDurationMs(test.data.latencyMs ?? 0)}${
                test.data.modelCount === null ? '' : `, ${test.data.modelCount} models`
              }`
            : test.data.message}
        </p>
      ) : null}

      {test.isError ? (
        <p role="alert" className="text-[0.6875rem] text-danger-text">
          {test.error.message}
        </p>
      ) : null}

      {fetchModels.isSuccess ? (
        <p role="status" aria-live="polite" className="text-[0.6875rem] tabular-nums text-text-muted">
          {`Discovered ${formatCount(fetchModels.data.models.length)} ${
            fetchModels.data.models.length === 1 ? 'model' : 'models'
          }`}
        </p>
      ) : null}

      {fetchModels.isError ? (
        <p role="alert" className="text-[0.6875rem] text-danger-text">
          {fetchModels.error.message}
        </p>
      ) : null}
    </div>
  );
}
