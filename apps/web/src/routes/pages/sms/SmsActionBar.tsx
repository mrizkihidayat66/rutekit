import { RefreshCw, Trash2, X } from 'lucide-react';

import { Button } from '@web/components/ui/Button.tsx';
import { formatCount } from '@web/lib/format.ts';

/**
 * What to do with the keys that are ticked.
 *
 * Appears only when something is selected, because a bar that is always there
 * saying "nothing selected" is a bar nobody reads. The count leads, so the two
 * buttons are never pressed without the operator knowing how many rows they
 * reach — which matters most for the destructive one.
 *
 * Checking is offered here as well as over the whole pool because the two
 * questions are different: "has anything run dry" is asked of everything, "does
 * the one I just added work" is asked of a selection. Deleting is only here for a
 * selection, since a single row has its own button.
 */
export interface SmsActionBarProps {
  readonly count: number;
  readonly checking: boolean;
  /** Why the last check failed, if it did. */
  readonly error: string | null;
  readonly onCheck: () => void;
  readonly onDelete: () => void;
  readonly onClear: () => void;
}

export function SmsActionBar({
  count,
  checking,
  error,
  onCheck,
  onDelete,
  onClear,
}: SmsActionBarProps) {
  if (count === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div
        role="group"
        aria-label="Bulk actions"
        className="animate-slide-up flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface-2 px-3 py-2"
      >
        <span className="text-xs text-text-muted">
          <span className="font-medium tabular-nums text-text">{formatCount(count)}</span>{' '}
          {count === 1 ? 'key' : 'keys'} selected
        </span>

        <span className="ml-auto flex items-center gap-2">
          <Button variant="secondary" size="sm" loading={checking} onClick={onCheck}>
            <RefreshCw aria-hidden="true" className="size-3.5" />
            Check selected
          </Button>
          <Button variant="danger" size="sm" onClick={onDelete}>
            <Trash2 aria-hidden="true" className="size-3.5" />
            Delete selected
          </Button>
          <Button variant="ghost" size="sm" onClick={onClear}>
            <X aria-hidden="true" className="size-3.5" />
            Clear
          </Button>
        </span>
      </div>

      {checking ? (
        <p role="status" aria-live="polite" className="text-xs text-text-muted">
          Checking {formatCount(count)} {count === 1 ? 'key' : 'keys'}…
        </p>
      ) : null}

      {error === null ? null : (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      )}
    </div>
  );
}
