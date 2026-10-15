import { Check, TriangleAlert, X } from 'lucide-react';
import { useState } from 'react';

import type { BulkResult } from '@contracts';

import { Button } from '@web/components/ui/Button.tsx';
import { ConfirmDialog } from '@web/components/ui/Dialog.tsx';
import { Field } from '@web/components/ui/Field.tsx';
import { Textarea } from '@web/components/ui/Textarea.tsx';
import { useBulkAccountAction } from '@web/hooks/use-providers.ts';
import { cn } from '@web/lib/cn.ts';
import { formatCount } from '@web/lib/format.ts';

import { BULK_ACTIONS, BULK_CONFIRMATIONS, bulkAction, type BulkActionId } from './accounts.ts';

/**
 * The bar that acts on a multi-row selection.
 *
 * A bulk endpoint answers per id rather than as one error, because one dead row
 * in a paste of fifty is normal (contracts: `bulkResultSchema`). So the bar
 * reports a tally and then the failures by name — an operator who selected
 * twelve credentials and saw "9 succeeded" needs to know *which* three, not
 * merely that something went wrong.
 *
 * The selection is cleared once the action settles, whether or not it succeeded.
 * Leaving it ticked would make the next click act on rows the operator has
 * already dealt with; the result banner is what carries the outcome forward.
 */

export interface BulkActionBarProps {
  readonly ids: readonly string[];
  readonly onClear: () => void;
  readonly className?: string;
}

export function BulkActionBar({ ids, onClear, className }: BulkActionBarProps) {
  const bulk = useBulkAccountAction();
  const [confirming, setConfirming] = useState<BulkActionId | null>(null);
  const [note, setNote] = useState('');
  const [result, setResult] = useState<BulkResult | null>(null);

  const run = (action: BulkActionId, withNote: string) => {
    setResult(null);
    bulk.mutate(
      { ids: [...ids], action, note: withNote.trim() === '' ? null : withNote.trim() },
      {
        onSuccess: (data) => {
          setResult(data);
          onClear();
        },
      },
    );
  };

  const start = (action: BulkActionId) => {
    setNote('');
    if (bulkAction(action).confirm) {
      setConfirming(action);
      return;
    }
    run(action, '');
  };

  if (ids.length === 0 && result === null) return null;

  const confirmation = confirming === null ? null : BULK_CONFIRMATIONS[confirming];

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {ids.length === 0 ? null : (
        <div
          role="group"
          aria-label="Bulk actions"
          className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface-2 px-3 py-2.5 animate-slide-up"
        >
          <p className="mr-1 text-xs text-text" aria-live="polite">
            <span className="font-medium tabular-nums">{formatCount(ids.length)}</span>{' '}
            {ids.length === 1 ? 'account' : 'accounts'} selected
          </p>

          <div className="flex flex-wrap items-center gap-1.5">
            {BULK_ACTIONS.map((action) => (
              <Button
                key={action.id}
                size="sm"
                variant={action.destructive ? 'danger' : 'secondary'}
                disabled={bulk.isPending}
                onClick={() => {
                  start(action.id);
                }}
              >
                {action.label}
              </Button>
            ))}
          </div>

          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={bulk.isPending}
            onClick={() => {
              onClear();
            }}
          >
            Clear
          </Button>
        </div>
      )}

      {bulk.isPending ? (
        <p role="status" aria-live="polite" className="text-xs text-text-muted">
          Applying to {formatCount(ids.length)} {ids.length === 1 ? 'account' : 'accounts'}…
        </p>
      ) : null}

      {bulk.isError ? (
        <p
          role="alert"
          className="rounded-control border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger-text"
        >
          {bulk.error.message}
        </p>
      ) : null}

      {result === null ? null : (
        <div
          role={result.failed > 0 ? 'alert' : 'status'}
          className={cn(
            'flex flex-col gap-2 rounded-control border px-3 py-2.5 text-xs',
            result.failed > 0
              ? 'border-warning/40 bg-warning/10 text-warning-text'
              : 'border-success/30 bg-success/10 text-success-text',
          )}
        >
          <div className="flex items-center gap-2">
            {result.failed > 0 ? (
              <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
            ) : (
              <Check aria-hidden="true" className="size-3.5 shrink-0" />
            )}
            <span className="tabular-nums">
              {formatCount(result.succeeded)} of {formatCount(result.requested)} succeeded
              {result.failed > 0 ? `, ${formatCount(result.failed)} failed` : ''}
            </span>
            <button
              type="button"
              aria-label="Dismiss result"
              onClick={() => {
                setResult(null);
              }}
              className="ml-auto rounded-control p-0.5 outline-none transition-colors duration-(--dur-micro) hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </div>

          {result.errors.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {result.errors.map((failure) => (
                <li key={failure.id} className="flex gap-2">
                  <span className="shrink-0 font-mono text-[0.6875rem]">{failure.id}</span>
                  <span className="text-text-muted">{failure.message}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={confirmation?.title ?? 'Confirm'}
        description={confirmation?.body}
        destructive={confirming !== null && bulkAction(confirming).destructive}
        confirmLabel={confirming === null ? 'Confirm' : bulkAction(confirming).label}
        onConfirm={() => {
          if (confirming === null) return;
          run(confirming, note);
          setConfirming(null);
        }}
      >
        <p className="text-xs text-text-muted">
          This applies to{' '}
          <span className="font-medium tabular-nums text-text">{formatCount(ids.length)}</span>{' '}
          {ids.length === 1 ? 'account' : 'accounts'}.
        </p>
        <Field label="Note" description="Optional. Stored against each account for the audit trail.">
          {({ id, describedBy }) => (
            <Textarea
              id={id}
              aria-describedby={describedBy}
              autoGrow
              rows={2}
              value={note}
              placeholder="Why this was done."
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          )}
        </Field>
      </ConfirmDialog>
    </div>
  );
}
