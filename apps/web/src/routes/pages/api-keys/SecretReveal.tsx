import { ShieldCheck, TriangleAlert } from 'lucide-react';

import { CopyButton } from '@web/components/patterns/CopyButton.tsx';

/**
 * The one chance to read a key's secret.
 *
 * The server keeps a hash and never returns the secret again (FR-6.7), so this
 * step is not a nicety — it is the whole of what creating a key hands back. That
 * is why the warning is above the value rather than beside it: an operator who
 * reads top to bottom meets "copy this now" before they meet the thing to copy,
 * instead of discovering afterwards that they should have.
 *
 * The secret is selectable and monospaced because the second most likely way to
 * move it is by hand, into a config file on a machine that has no clipboard
 * shared with this browser.
 */

export interface SecretRevealProps {
  /** The name the key was given, or `null` if the dialog is mid-creation. */
  readonly name: string | null;
  readonly secret: string;
}

export function SecretReveal({ name, secret }: SecretRevealProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-card border border-warning/35 bg-warning/10 p-3">
        <p className="flex items-start gap-2 text-xs text-warning-text">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Store it somewhere safe before closing this. Anyone holding it can spend the budgets and
            reach the models this key was given.
          </span>
        </p>
      </div>

      <div className="rounded-card border border-border bg-surface-2">
        <header className="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
          <h3 className="truncate text-xs font-semibold text-text">
            {name === null ? 'New key' : name} secret
          </h3>
          <CopyButton value={secret} label="API key secret" />
        </header>
        <p className="px-3 py-3 font-mono text-xs break-all text-text select-all">{secret}</p>
      </div>

      <p className="flex items-center gap-1.5 text-[0.6875rem] text-text-subtle">
        <ShieldCheck aria-hidden="true" className="size-3.5 shrink-0" />
        The key is active immediately and appears in the list behind this dialog.
      </p>
    </div>
  );
}
