import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@web/lib/cn.ts';

/**
 * A control that puts one value on the clipboard and says so.
 *
 * Copying has no visible effect of its own, so the button is also the receipt:
 * it confirms in place, on itself, for a moment. A toast would report the same
 * thing further away from where the operator is looking, and would need to be
 * dismissed — which is the opposite of what a one-word confirmation is for.
 *
 * The label names what is being copied rather than being a bare "Copy", because
 * a screen reader meets these in a list of several and needs to tell them apart.
 */

export interface CopyButtonProps {
  readonly value: string;
  /** What is being copied, e.g. "request body" or "API key secret". */
  readonly label: string;
  /**
   * Drop the word and keep the icon.
   *
   * A table cell that is one number has no room for a word beside it, and the
   * word would repeat down every row — but the receipt still has to be visible,
   * so the icon swaps to a check in place. The accessible name is unaffected;
   * it already names what is being copied.
   */
  readonly iconOnly?: boolean;
  readonly className?: string;
}

const COPIED_MS = 1500;

export function CopyButton({ value, label, iconOnly = false, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, COPIED_MS);
    });
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-key text-[0.6875rem] text-text-subtle',
        iconOnly ? 'p-0.5' : 'px-1.5 py-0.5',
        'transition-colors duration-(--dur-micro) outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus',
        className,
      )}
    >
      {copied ? (
        <Check aria-hidden="true" className="size-3 text-success" />
      ) : (
        <Copy aria-hidden="true" className="size-3" />
      )}
      {iconOnly ? null : copied ? 'Copied' : 'Copy'}
    </button>
  );
}
